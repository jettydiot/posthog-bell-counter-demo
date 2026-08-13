/**
 * The load-bearing behaviour of the whole demo: the bell rings *first*, the
 * authoritative count is queried *after* that attempt has settled, and the
 * display is only written *after* every project has answered.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBellRunner } from '../src/runner.js';
import { createJettydClient } from '../src/jettyd.js';
import { createPostHogClient } from '../src/posthog.js';
import { captureLogger, mockFetch, posthogCounts, testConfig } from './helpers.js';

function buildRunner(fetchImpl, config = testConfig()) {
  const { logger, records } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  const runner = createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });
  return { runner, records };
}

describe('strict ordering: servo → PostHog → display', () => {
  it('issues servo.rotate, then all project queries, then display.set', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 4, 100002: 3, 100003: 2 }));
    const { runner } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    assert.deepEqual(fetchImpl.kinds(), [
      'jettyd:servo.rotate',
      'posthog:100001',
      'posthog:100002',
      'posthog:100003',
      'jettyd:display.set',
    ]);
  });

  it('does not start a PostHog query until the servo request has settled', async () => {
    const order = [];
    let servoSettled = false;

    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body);
      if (body.command_type === 'servo.rotate') {
        order.push('servo:start');
        await new Promise((resolve) => setTimeout(resolve, 20));
        servoSettled = true;
        order.push('servo:end');
        return { ok: true, status: 200, json: async () => ({}) };
      }
      if (String(url).includes('/query')) {
        order.push(`query:${servoSettled ? 'after-servo' : 'DURING-SERVO'}`);
        return { ok: true, status: 200, json: async () => ({ results: [[1]] }) };
      }
      order.push('display');
      return { ok: true, status: 200, json: async () => ({}) };
    };

    const { runner } = buildRunner(fetchImpl);
    await runner.trigger('webhook');

    assert.deepEqual(order.slice(0, 2), ['servo:start', 'servo:end']);
    assert.ok(
      !order.some((step) => step.includes('DURING-SERVO')),
      `a query overlapped the strike: ${order.join(' → ')}`,
    );
    assert.equal(order.at(-1), 'display');
  });

  it('writes the display exactly once per run', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
    const { runner } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    const displayCalls = fetchImpl.calls.filter((c) => c.kind === 'jettyd:display.set');
    assert.equal(displayCalls.length, 1);
  });

  it('reconciliation queries then displays, and never rings the bell', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 5, 100002: 0, 100003: 0 }));
    const { runner } = buildRunner(fetchImpl);

    await runner.reconcile('scheduler');

    assert.deepEqual(fetchImpl.kinds(), [
      'posthog:100001',
      'posthog:100002',
      'posthog:100003',
      'jettyd:display.set',
    ]);
  });
});
