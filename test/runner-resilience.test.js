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
import { createLogger } from '../src/logger.js';
import {
  captureLogger,
  deferred,
  flush,
  jsonResponse,
  mockFetch,
  posthogCounts,
  testConfig,
} from './helpers.js';

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
      ...posthogCounts({ 100001: 4, 100002: 3, 100003: 2 }),
      'jettyd:servo.rotate': jsonResponse(500, { error: 'device offline' }),
    });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.bell.ok, false);
    assert.equal(result.displayed, true);
    assert.equal(result.count, 9);
    assert.deepEqual(fetchImpl.kinds(), [
      'jettyd:servo.rotate',
      'posthog:100001',
      'posthog:100002',
      'posthog:100003',
      'jettyd:display.set',
    ]);
  });

  it('still updates the display when the servo request throws outright', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }),
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
      ...posthogCounts({ 100001: 1, 100002: 0, 100003: 0 }),
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
      'posthog:100001': jsonResponse(200, { results: [[12]] }),
      'posthog:100002': jsonResponse(503, {}),
      'posthog:100003': jsonResponse(200, { results: [[5]] }),
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
    const fetchImpl = mockFetch({ 'posthog:100002': jsonResponse(500, {}) });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.bell.ok, true);
    assert.ok(fetchImpl.kinds().includes('jettyd:servo.rotate'));
  });

  it('reports the failure without throwing out of the run', async () => {
    const fetchImpl = mockFetch({ 'posthog:100003': jsonResponse(500, {}) });
    const { runner, find } = buildRunner(fetchImpl);

    const result = await runner.trigger('webhook');

    assert.equal(result.ok, false);
    assert.equal(result.error.stage, 'query');
    assert.equal(find('query.failed').length, 1);
  });

  it('applies the same all-or-nothing rule to a scheduled reconcile', async () => {
    const fetchImpl = mockFetch({ 'posthog:100001': jsonResponse(500, {}) });
    const { runner } = buildRunner(fetchImpl);

    const result = await runner.reconcile('scheduler');

    assert.equal(result.displayed, false);
    assert.ok(!fetchImpl.kinds().includes('jettyd:display.set'));
  });
});

describe('a display failure is reported, not swallowed', () => {
  it('marks the run as not displayed when display.set errors', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 100001: 2, 100002: 2, 100003: 2 }),
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

/**
 * Every path out of the runner produces the same object. A caller — /healthz
 * above all — should never have to ask which branch built the thing it is
 * reading, and the fields that go missing when a branch builds its own are
 * exactly the ones needed to debug the failure that took that branch.
 */
const RESULT_FIELDS = [
  'runId',
  'kind',
  'trigger',
  'coalesced',
  'ok',
  'bell',
  'count',
  'perProject',
  'displayed',
  'error',
  'at',
  'durationMs',
];

describe('every result has the same shape', () => {
  /** A runner whose runOnce blows up outside its own error handling. */
  function brokenRunner() {
    const config = testConfig();
    const { logger } = captureLogger();
    const deps = { fetch: mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 })), logger };
    return createBellRunner({
      config,
      jettyd: createJettydClient(config, deps),
      posthog: createPostHogClient(config, deps),
      // child() is called before the run's try blocks exist, so this reaches the
      // last-resort handler rather than the query or display branch.
      logger: {
        ...logger,
        child: () => {
          throw new Error('logger exploded');
        },
      },
    });
  }

  it('reports stage "internal" when the run throws outside its own handling', async () => {
    const result = await brokenRunner().trigger('webhook');

    assert.equal(result.ok, false);
    assert.equal(result.error.stage, 'internal');
    assert.match(result.error.message, /logger exploded/);
  });

  it('gives an internal failure the full field set', async () => {
    const result = await brokenRunner().trigger('webhook');

    for (const field of RESULT_FIELDS) {
      assert.equal(field in result, true, `an internal failure is missing ${field}`);
    }
    assert.equal(result.kind, 'bell');
    assert.equal(result.trigger, 'webhook');
    assert.equal(result.coalesced, 1);
    assert.equal(result.displayed, false);
    assert.equal(result.perProject, null);
    assert.ok(Date.parse(result.at), 'at must be a timestamp, not undefined');
    assert.equal(typeof result.durationMs, 'number');
  });

  it('records an internal failure as the last run, not the previous success', async () => {
    const runner = brokenRunner();
    await runner.trigger('webhook');

    const { lastRun } = runner.stats();
    assert.ok(lastRun, 'a failed run still happened, and /healthz has to say so');
    assert.equal(lastRun.ok, false);
    assert.equal(lastRun.error.stage, 'internal');
  });

  it('resolves the caller rather than stranding it on an internal failure', async () => {
    // The whole point of the last-resort handler: a webhook must never hang.
    const result = await Promise.race([
      brokenRunner().trigger('webhook'),
      new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 500)),
    ]);
    assert.notEqual(result, 'TIMED OUT');
  });

  it('resolves the caller even when the logger itself is what is broken', async () => {
    // The nastiest version: the logger is one of the few things called outside
    // runOnce's own try blocks, so it is a likely cause of an internal failure
    // *and* the thing the handler would use to report it. Reporting the failure
    // must not be able to cause a second one.
    const config = testConfig();
    const dead = () => {
      throw new Error('stdout is gone');
    };
    const runner = createBellRunner({
      config,
      jettyd: createJettydClient(config, { fetch: mockFetch(), logger: { debug() {} } }),
      posthog: createPostHogClient(config, { fetch: mockFetch(), logger: { debug() {} } }),
      logger: { debug: dead, info: dead, warn: dead, error: dead, child: dead },
    });

    const result = await Promise.race([
      runner.trigger('webhook'),
      new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 500)),
    ]);

    assert.notEqual(result, 'TIMED OUT', 'a dead logger must not strand the caller');
    assert.equal(result.error.stage, 'internal');
    assert.equal(runner.stats().busy, false, 'the run slot has to be released too');
  });

  it('keeps draining the queue when the logger is dead', async () => {
    // A stranded job would also abandon everything queued behind it.
    const config = testConfig();
    const dead = () => {
      throw new Error('stdout is gone');
    };
    const runner = createBellRunner({
      config,
      jettyd: createJettydClient(config, { fetch: mockFetch(), logger: { debug() {} } }),
      posthog: createPostHogClient(config, { fetch: mockFetch(), logger: { debug() {} } }),
      logger: { debug: dead, info: dead, warn: dead, error: dead, child: dead },
    });

    const results = await Promise.race([
      Promise.all([runner.trigger('webhook'), runner.trigger('webhook')]),
      new Promise((resolve) => setTimeout(() => resolve('TIMED OUT'), 500)),
    ]);

    assert.notEqual(results, 'TIMED OUT');
    assert.equal(results.length, 2);
  });
});

describe('the logger never breaks the thing it is describing', () => {
  it('drops a line rather than propagating a sink failure', () => {
    const logger = createLogger({
      level: 'info',
      sink: () => {
        throw new Error('EPIPE: broken pipe');
      },
    });

    assert.doesNotThrow(() => logger.info('run.finished', { count: 1 }));
  });

  /**
   * A fetch double whose servo call blocks only while the gate is armed, so one
   * test can let a run complete and then pin the next one open.
   */
  function armableFetch(countPerProject) {
    let gate = null;
    const fn = async (url, options) => {
      const body = JSON.parse(options.body ?? '{}');
      if (body.command_type === 'servo.rotate' && gate) await gate.promise;
      if (String(url).includes('/query')) {
        return jsonResponse(200, { results: [[countPerProject]] });
      }
      return jsonResponse(200, {});
    };
    fn.arm = () => {
      gate = deferred();
    };
    fn.release = () => {
      gate?.resolve();
      gate = null;
    };
    return fn;
  }

  it('gives a skipped reconcile the same field set, plus skipped', async () => {
    const fetchImpl = armableFetch(1);
    const { runner } = buildRunner(fetchImpl);

    fetchImpl.arm();
    const bellRun = runner.trigger('webhook');
    await flush();
    const queued = runner.reconcile('scheduler'); // takes the one queue slot
    const skipped = await runner.reconcile('scheduler'); // finds it taken

    for (const field of RESULT_FIELDS) {
      assert.equal(field in skipped, true, `a skipped reconcile is missing ${field}`);
    }
    assert.equal(skipped.skipped, true);
    assert.equal(skipped.kind, 'reconcile');
    assert.equal(skipped.trigger, 'scheduler');
    assert.equal(skipped.ok, true, 'nothing went wrong — there was simply nothing to do');
    assert.equal(skipped.displayed, false);
    assert.equal(skipped.count, null);
    assert.equal(skipped.bell.attempted, false);

    fetchImpl.release();
    await Promise.all([bellRun, queued]);
  });

  it('does not let a skipped reconcile overwrite the real last run', async () => {
    const fetchImpl = armableFetch(3);
    const { runner } = buildRunner(fetchImpl);

    // One run that genuinely happens, and is what /healthz should keep showing.
    await runner.trigger('webhook');
    const realRun = runner.stats().lastRun;
    assert.equal(realRun.count, 9);

    // Now pin a second run open and force a skip behind it.
    fetchImpl.arm();
    const held = runner.trigger('webhook');
    await flush();
    const queued = runner.reconcile('scheduler');
    const skipped = await runner.reconcile('scheduler');
    assert.equal(skipped.skipped, true);

    const { lastRun } = runner.stats();
    assert.equal(lastRun.runId, realRun.runId, 'a no-op must not become the last run');
    assert.equal(lastRun.count, 9);

    fetchImpl.release();
    await Promise.all([held, queued]);
  });
});
