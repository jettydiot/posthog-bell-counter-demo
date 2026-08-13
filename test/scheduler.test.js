import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startReconcileScheduler } from '../src/scheduler.js';
import { captureLogger, testConfig } from './helpers.js';

/** Timer double: records registrations and lets a test fire a tick by hand. */
function fakeTimers() {
  const registered = [];
  const cleared = [];
  return {
    registered,
    cleared,
    setInterval(fn, ms) {
      const handle = { fn, ms, id: registered.length, unref() {} };
      registered.push(handle);
      return handle;
    },
    clearInterval(handle) {
      cleared.push(handle);
    },
    async tick(index = 0) {
      await registered[index].fn();
    },
  };
}

function stubRunner() {
  const calls = [];
  return {
    calls,
    reconcile: async (reason) => {
      calls.push(reason);
      return { ok: true, displayed: true, count: 1 };
    },
    stats: () => ({ busy: false }),
  };
}

describe('reconcile scheduler', () => {
  it('defaults to every 15 minutes', () => {
    const timers = fakeTimers();
    const { logger } = captureLogger();
    const config = testConfig();

    const scheduler = startReconcileScheduler({
      intervalMinutes: config.reconcileIntervalMinutes,
      runner: stubRunner(),
      logger,
      timers,
    });

    assert.equal(scheduler.enabled, true);
    assert.equal(scheduler.intervalMs, 15 * 60 * 1000);
    assert.equal(timers.registered[0].ms, 15 * 60 * 1000);
  });

  it('honours a configured interval', () => {
    const timers = fakeTimers();
    const { logger } = captureLogger();
    const config = testConfig({ RECONCILE_INTERVAL_MINUTES: '2' });

    const scheduler = startReconcileScheduler({
      intervalMinutes: config.reconcileIntervalMinutes,
      runner: stubRunner(),
      logger,
      timers,
    });

    assert.equal(scheduler.intervalMs, 2 * 60 * 1000);
    assert.equal(timers.registered[0].ms, 2 * 60 * 1000);
  });

  it('is disabled by an interval of 0 and registers no timer', () => {
    const timers = fakeTimers();
    const { logger, records } = captureLogger();

    const scheduler = startReconcileScheduler({
      intervalMinutes: 0,
      runner: stubRunner(),
      logger,
      timers,
    });

    assert.equal(scheduler.enabled, false);
    assert.equal(timers.registered.length, 0);
    assert.equal(records.filter((r) => r.event === 'reconcile.disabled').length, 1);
  });

  it('reconciles on each tick, and never rings the bell', async () => {
    const timers = fakeTimers();
    const { logger } = captureLogger();
    const runner = stubRunner();

    startReconcileScheduler({ intervalMinutes: 15, runner, logger, timers });
    await timers.tick();
    await timers.tick();

    assert.deepEqual(runner.calls, ['scheduler', 'scheduler']);
    assert.equal(runner.trigger, undefined, 'the scheduler only needs reconcile()');
  });

  it('survives a failing reconcile and keeps the timer alive', async () => {
    const timers = fakeTimers();
    const { logger, records } = captureLogger();
    let calls = 0;
    const runner = {
      reconcile: async () => {
        calls += 1;
        throw new Error('posthog down');
      },
    };

    startReconcileScheduler({ intervalMinutes: 15, runner, logger, timers });
    await timers.tick();
    await timers.tick();

    assert.equal(calls, 2);
    assert.equal(timers.cleared.length, 0);
    const errors = records.filter((r) => r.event === 'reconcile.error');
    assert.equal(errors.length, 2);
    assert.equal(errors[0].level, 'error');
  });

  it('stops cleanly', () => {
    const timers = fakeTimers();
    const { logger } = captureLogger();

    const scheduler = startReconcileScheduler({
      intervalMinutes: 15,
      runner: stubRunner(),
      logger,
      timers,
    });
    scheduler.stop();

    assert.equal(timers.cleared.length, 1);
    assert.equal(timers.cleared[0], timers.registered[0]);
  });

  it('stop() on a disabled scheduler is a no-op', () => {
    const timers = fakeTimers();
    const { logger } = captureLogger();

    const scheduler = startReconcileScheduler({
      intervalMinutes: 0,
      runner: stubRunner(),
      logger,
      timers,
    });
    scheduler.stop();

    assert.equal(timers.cleared.length, 0);
  });

  it('announces the schedule at startup', () => {
    const timers = fakeTimers();
    const { logger, records } = captureLogger();

    startReconcileScheduler({ intervalMinutes: 15, runner: stubRunner(), logger, timers });

    const started = records.filter((r) => r.event === 'reconcile.scheduled');
    assert.equal(started.length, 1);
    assert.equal(started[0].interval_minutes, 15);
  });
});
