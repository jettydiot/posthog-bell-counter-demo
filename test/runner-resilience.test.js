/**
 * What happens when part of the chain fails.
 *
 *   bell fails      → still query, still display (the number is the point)
 *   any project fails → display is NOT written (no partial truth on the panel)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBellRunner } from '../src/runner.js';
import { createJettydClient } from '../src/jettyd.js';
import { createPostHogClient } from '../src/posthog.js';
import { captureLogger, jsonResponse, mockFetch, posthogCounts, testConfig } from './helpers.js';

function buildRunner(fetchImpl, config = testConfig()) {
  const { logger, records } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  const runner = createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });
  return { runner, records, find: (event) => records.filter((r) => r.event === event) };
}

describe('bell failure does not stop the count', () => {
  it('still queries and still updates the display when servo.rotate errors', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 131280: 4, 214227: 3, 218818: 2 }),
      'jettyd:servo.rotate': jsonResponse(500, { error: 'device offline' }),
    });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.bell.ok, false);
    assert.equal(result.displayed, true);
    assert.equal(result.count, 9);
    assert.deepEqual(fetchImpl.kinds(), [
      'jettyd:servo.rotate',
      'posthog:131280',
      'posthog:214227',
      'posthog:218818',
      'jettyd:display.set',
    ]);
  });

  it('still updates the display when the servo request throws outright', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 131280: 1, 214227: 1, 218818: 1 }),
      'jettyd:servo.rotate': () => {
        throw new Error('ETIMEDOUT');
      },
    });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.bell.ok, false);
    assert.equal(result.displayed, true);
    assert.equal(result.count, 3);
  });

  it('logs the bell failure at warn without failing the run', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 131280: 1, 214227: 0, 218818: 0 }),
      'jettyd:servo.rotate': jsonResponse(503, {}),
    });
    const { runner, find } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.ok, true);
    const warnings = find('bell.failed');
    assert.equal(warnings.length, 1);
    assert.equal(warnings[0].level, 'warn');
  });
});

describe('a partial PostHog answer never reaches the panel', () => {
  it('skips display.set entirely when one project query fails', async () => {
    const fetchImpl = mockFetch({
      'posthog:131280': jsonResponse(200, { results: [[12]] }),
      'posthog:214227': jsonResponse(503, {}),
      'posthog:218818': jsonResponse(200, { results: [[5]] }),
    });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.displayed, false);
    assert.equal(result.count, null);
    assert.ok(
      !fetchImpl.kinds().includes('jettyd:display.set'),
      'the panel must keep its last good value rather than show a partial sum',
    );
  });

  it('still rings the bell — the strike happens before the query', async () => {
    const fetchImpl = mockFetch({ 'posthog:214227': jsonResponse(500, {}) });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.bell.ok, true);
    assert.ok(fetchImpl.kinds().includes('jettyd:servo.rotate'));
  });

  it('reports the failure without throwing out of the run', async () => {
    const fetchImpl = mockFetch({ 'posthog:218818': jsonResponse(500, {}) });
    const { runner, find } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.ok, false);
    assert.equal(result.error.stage, 'query');
    assert.equal(find('query.failed').length, 1);
  });

  it('applies the same all-or-nothing rule to a scheduled reconcile', async () => {
    const fetchImpl = mockFetch({ 'posthog:131280': jsonResponse(500, {}) });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.reconcile('scheduler');

    assert.equal(result.displayed, false);
    assert.ok(!fetchImpl.kinds().includes('jettyd:display.set'));
  });
});

describe('a display failure is reported, not swallowed', () => {
  it('marks the run as not displayed when display.set errors', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 131280: 2, 214227: 2, 218818: 2 }),
      'jettyd:display.set': jsonResponse(500, {}),
    });
    const { runner, find } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.count, 6);
    assert.equal(result.displayed, false);
    assert.equal(result.error.stage, 'display');
    assert.equal(find('display.failed').length, 1);
  });
});
