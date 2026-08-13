/**
 * The display always shows what PostHog says, never what this process counted.
 *
 * There is no local counter, no counter file and no in-memory tally: the number
 * on the panel is the answer to a fresh query, every single time.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

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
    const fetchImpl = mockFetch(posthogCounts({ 100001: 7, 100002: 0, 100003: 0 }));
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
      'posthog:100001': () => jsonResponse(200, { results: [[count]] }),
      'posthog:100002': jsonResponse(200, { results: [[0]] }),
      'posthog:100003': jsonResponse(200, { results: [[0]] }),
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
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
    const runner = buildRunner(fetchImpl);

    await runner.trigger('webhook');
    await runner.reconcile('scheduler');

    const queries = fetchImpl.calls.filter((c) => c.kind.startsWith('posthog:'));
    assert.equal(queries.length, 6, 'three projects, queried afresh for each run');
  });

  it('leaves no counter state on disk and no ++ in the source', () => {
    // The old version of this demo persisted a counter.json. Nothing here should.
    //
    // Recursive, so a src/ subdirectory added later cannot quietly escape the
    // scan. This is a tripwire, not the guarantee — the pattern only catches
    // `count++` and `count +=`, not `total++` or `count = count + 1`. The
    // behavioural tests above are what actually hold the property.
    const sources = sourceFiles();
    assert.ok(sources.length > 0, 'the scan found no source files — the path is wrong');

    for (const file of sources) {
      const text = readFileSync(file, 'utf8');
      assert.doesNotMatch(text, /counter\.json/i, `${file} must not persist a counter`);
      assert.doesNotMatch(
        text,
        /\bcount\s*(\+\+|\+=)/,
        `${file} must not increment a count locally`,
      );
    }
  });
});

/** Every `.js` file under src/, at any depth. */
function sourceFiles() {
  return readdirSync(SRC_DIR, { recursive: true })
    .map((entry) => join(SRC_DIR, String(entry)))
    .filter((path) => path.endsWith('.js') && statSync(path).isFile());
}
