/**
 * The display always shows what PostHog says, never what this process counted.
 *
 * There is no local counter, no counter file and no in-memory tally: the number
 * on the panel is the answer to a fresh query, every single time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { readFileSync } from 'node:fs';

import { createBellRunner } from '../src/runner.js';
import { createJettydClient } from '../src/jettyd.js';
import { createPostHogClient } from '../src/posthog.js';
import { captureLogger, jsonResponse, mockFetch, posthogCounts, testConfig } from './helpers.js';

const SRC_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'src');

function buildRunner(fetchImpl) {
  const config = testConfig();
  const { logger } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  return createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });
}

describe('the count is never derived locally', () => {
  it('shows the same number twice when PostHog reports the same number twice', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 131280: 7, 214227: 0, 218818: 0 }));
    const runner = buildRunner(fetchImpl);

    await runner.trigger('webhook');
    await runner.trigger('webhook');

    const displayed = fetchImpl.calls
      .filter((c) => c.kind === 'jettyd:display.set')
      .map((c) => c.body.payload.value);
    assert.deepEqual(displayed, [7, 7], 'the second webhook must not add one locally');
  });

  it('follows PostHog downwards when the authoritative count drops', async () => {
    let count = 10;
    const fetchImpl = mockFetch({
      'posthog:131280': () => jsonResponse(200, { results: [[count]] }),
      'posthog:214227': jsonResponse(200, { results: [[0]] }),
      'posthog:218818': jsonResponse(200, { results: [[0]] }),
    });
    const runner = buildRunner(fetchImpl);

    await runner.trigger('webhook');
    count = 4; // e.g. a month rollover, or events deleted upstream
    await runner.trigger('webhook');

    const displayed = fetchImpl.calls
      .filter((c) => c.kind === 'jettyd:display.set')
      .map((c) => c.body.payload.value);
    assert.deepEqual(displayed, [10, 4]);
  });

  it('re-queries on every run rather than caching the previous total', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 131280: 1, 214227: 1, 218818: 1 }));
    const runner = buildRunner(fetchImpl);

    await runner.trigger('webhook');
    await runner.reconcile('scheduler');

    const queries = fetchImpl.calls.filter((c) => c.kind.startsWith('posthog:'));
    assert.equal(queries.length, 6, 'three projects, queried afresh for each run');
  });

  it('leaves no counter state on disk and no ++ in the source', () => {
    // The old version of this demo persisted a counter.json. Nothing here should.
    const sources = readdirSync(SRC_DIR).filter((f) => f.endsWith('.js'));
    for (const file of sources) {
      const text = readFileSync(join(SRC_DIR, file), 'utf8');
      assert.doesNotMatch(text, /counter\.json/i, `${file} must not persist a counter`);
      assert.doesNotMatch(
        text,
        /\bcount\s*(\+\+|\+=)/,
        `${file} must not increment a count locally`,
      );
    }
  });
});
