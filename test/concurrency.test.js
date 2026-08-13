/**
 * A bell that is already swinging must not be told to swing again.
 *
 * Webhook bursts are real: PostHog fires one request per matching event, and
 * three claims in the same second would otherwise produce three interleaved
 * strike/query/display chains against one servo. Runs are serialised, and
 * everything that arrives during a run is coalesced into a single follow-up.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createBellRunner } from '../src/runner.js';
import { createJettydClient } from '../src/jettyd.js';
import { createPostHogClient } from '../src/posthog.js';
import { captureLogger, deferred, flush, posthogCounts, mockFetch, testConfig } from './helpers.js';

/**
 * A fetch double that keeps every servo.rotate pending until released, and
 * records the maximum number of strikes in flight at once.
 */
function gatedFetch() {
  const gates = [];
  let inFlight = 0;
  let maxInFlight = 0;
  const kinds = [];

  const fn = async (url, options) => {
    const body = JSON.parse(options.body ?? '{}');
    const kind = String(url).includes('/query')
      ? `posthog:${String(url).match(/projects\/(\d+)/)[1]}`
      : `jettyd:${body.command_type}`;
    kinds.push(kind);

    if (kind === 'jettyd:servo.rotate') {
      inFlight += 1;
      maxInFlight = Math.max(maxInFlight, inFlight);
      const gate = deferred();
      gates.push(gate);
      await gate.promise;
      inFlight -= 1;
      return { ok: true, status: 200, json: async () => ({}) };
    }

    if (kind.startsWith('posthog:')) {
      return { ok: true, status: 200, json: async () => ({ results: [[1]] }) };
    }
    return { ok: true, status: 200, json: async () => ({}) };
  };

  fn.gates = gates;
  fn.kinds = () => kinds;
  fn.strikes = () => kinds.filter((k) => k === 'jettyd:servo.rotate').length;
  fn.displays = () => kinds.filter((k) => k === 'jettyd:display.set').length;
  fn.maxInFlight = () => maxInFlight;
  fn.releaseAll = async () => {
    while (gates.length) gates.shift().resolve();
    await flush();
  };
  return fn;
}

function buildRunner(fetchImpl) {
  const config = testConfig();
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

async function settle(fetchImpl, rounds = 8) {
  for (let i = 0; i < rounds; i++) {
    await fetchImpl.releaseAll();
    await flush();
  }
}

describe('concurrent webhooks are serialised', () => {
  it('never has two strikes in flight at the same time', async () => {
    const fetchImpl = gatedFetch();
    const { runner } = buildRunner(fetchImpl);

    const runs = [
      runner.trigger('webhook'),
      runner.trigger('webhook'),
      runner.trigger('webhook'),
      runner.trigger('webhook'),
      runner.trigger('webhook'),
    ];

    await settle(fetchImpl);
    await Promise.all(runs);

    assert.equal(fetchImpl.maxInFlight(), 1);
  });

  it('coalesces a burst into one in-flight run plus one follow-up', async () => {
    const fetchImpl = gatedFetch();
    const { runner } = buildRunner(fetchImpl);

    const runs = [
      runner.trigger('webhook'),
      runner.trigger('webhook'),
      runner.trigger('webhook'),
      runner.trigger('webhook'),
      runner.trigger('webhook'),
    ];

    await settle(fetchImpl);
    await Promise.all(runs);

    assert.equal(fetchImpl.strikes(), 2, 'five simultaneous webhooks → two strikes');
    assert.equal(fetchImpl.displays(), 2);
  });

  it('tells the coalesced callers how many requests their run covered', async () => {
    const fetchImpl = gatedFetch();
    const { runner } = buildRunner(fetchImpl);

    const first = runner.trigger('webhook');
    await flush();
    const followers = [runner.trigger('webhook'), runner.trigger('webhook')];

    await settle(fetchImpl);
    const [firstResult, ...followerResults] = await Promise.all([first, ...followers]);

    assert.equal(firstResult.coalesced, 1);
    for (const result of followerResults) {
      assert.equal(result.coalesced, 2, 'both followers share one coalesced run');
    }
    assert.equal(followerResults[0].runId, followerResults[1].runId);
    assert.notEqual(firstResult.runId, followerResults[0].runId);
  });

  it('logs the coalescing so a burst is visible after the fact', async () => {
    const fetchImpl = gatedFetch();
    const { runner, find } = buildRunner(fetchImpl);

    const runs = [runner.trigger('webhook'), runner.trigger('webhook'), runner.trigger('webhook')];
    await settle(fetchImpl);
    await Promise.all(runs);

    assert.equal(find('run.coalesced').length, 2);
  });

  it('keeps the whole chain of one run contiguous', async () => {
    const fetchImpl = gatedFetch();
    const { runner } = buildRunner(fetchImpl);

    const runs = [runner.trigger('webhook'), runner.trigger('webhook')];
    await settle(fetchImpl);
    await Promise.all(runs);

    assert.deepEqual(fetchImpl.kinds(), [
      'jettyd:servo.rotate',
      'posthog:100001',
      'posthog:100002',
      'posthog:100003',
      'jettyd:display.set',
      'jettyd:servo.rotate',
      'posthog:100001',
      'posthog:100002',
      'posthog:100003',
      'jettyd:display.set',
    ]);
  });

  it('runs sequentially awaited webhooks one apiece — no coalescing', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
    const { runner } = buildRunner(fetchImpl);

    await runner.trigger('webhook');
    await runner.trigger('webhook');
    await runner.trigger('webhook');

    assert.equal(fetchImpl.calls.filter((c) => c.kind === 'jettyd:servo.rotate').length, 3);
  });

  it('reports idle/busy state for the health endpoint', async () => {
    const fetchImpl = gatedFetch();
    const { runner } = buildRunner(fetchImpl);

    assert.equal(runner.stats().busy, false);
    const run = runner.trigger('webhook');
    await flush();
    assert.equal(runner.stats().busy, true);

    await settle(fetchImpl);
    await run;
    assert.equal(runner.stats().busy, false);
  });
});

describe('reconciliation does not interleave with a strike', () => {
  it('waits for an in-flight bell run before writing the display', async () => {
    const fetchImpl = gatedFetch();
    const { runner } = buildRunner(fetchImpl);

    const bellRun = runner.trigger('webhook');
    await flush();
    const reconcileRun = runner.reconcile('scheduler');
    await flush();

    // The bell run is pinned open on its servo gate; the reconcile must not have
    // pushed a display.set past it.
    assert.equal(fetchImpl.displays(), 0);

    await settle(fetchImpl);
    await Promise.all([bellRun, reconcileRun]);

    assert.equal(fetchImpl.displays(), 2, 'the bell run and the reconcile each write the display');
    assert.equal(fetchImpl.strikes(), 1, 'reconcile must not ring the bell');
  });

  it('skips a scheduled reconcile when one is already queued', async () => {
    const fetchImpl = gatedFetch();
    const { runner, find } = buildRunner(fetchImpl);

    const bellRun = runner.trigger('webhook');
    await flush();
    const first = runner.reconcile('scheduler');
    const second = runner.reconcile('scheduler');
    await flush();

    await settle(fetchImpl);
    const [, firstResult, secondResult] = await Promise.all([bellRun, first, second]);

    assert.equal([firstResult.skipped, secondResult.skipped].filter(Boolean).length, 1);
    assert.equal(find('reconcile.skipped').length, 1);
  });
});
