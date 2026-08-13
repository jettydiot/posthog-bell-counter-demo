import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loadConfig, ConfigError } from '../src/config.js';
import { TEST_ENV, catchSync } from './helpers.js';

describe('loadConfig', () => {
  it('reads every secret from the environment and nothing from disk', () => {
    const config = loadConfig(TEST_ENV);
    assert.equal(config.webhookSecret, 'test-webhook-secret');
    assert.equal(config.jettyd.token, 'jettyd-token-abc');
    assert.equal(config.posthog.apiKey, 'phx_test_key');
  });

  it('takes the PostHog projects from the environment', () => {
    const config = loadConfig(TEST_ENV);
    assert.deepEqual(config.posthog.projectIds, ['100001', '100002', '100003']);
  });

  it('has no built-in project ids — this repository is public', () => {
    // A default here would ship the operator's real project ids in the source.
    const err = catchSync(() => loadConfig({ ...TEST_ENV, POSTHOG_PROJECT_IDS: '' }), ConfigError);
    assert.match(err.message, /POSTHOG_PROJECT_IDS is required/);
    assert.equal(
      err.problems.filter((p) => p.includes('POSTHOG_PROJECT_IDS')).length,
      1,
      'one missing variable should produce exactly one problem line',
    );
  });

  it('rejects a non-numeric project id', () => {
    assert.throws(
      () => loadConfig({ ...TEST_ENV, POSTHOG_PROJECT_IDS: '100001,not-a-project' }),
      ConfigError,
    );
  });

  it('defaults the reconcile interval to 15 minutes', () => {
    assert.equal(loadConfig(TEST_ENV).reconcileIntervalMinutes, 15);
  });

  it('honours a configured reconcile interval', () => {
    const config = loadConfig({ ...TEST_ENV, RECONCILE_INTERVAL_MINUTES: '3' });
    assert.equal(config.reconcileIntervalMinutes, 3);
  });

  it('accepts 0 to disable reconciliation', () => {
    const config = loadConfig({ ...TEST_ENV, RECONCILE_INTERVAL_MINUTES: '0' });
    assert.equal(config.reconcileIntervalMinutes, 0);
  });

  it('rejects a negative or non-numeric reconcile interval', () => {
    assert.throws(() => loadConfig({ ...TEST_ENV, RECONCILE_INTERVAL_MINUTES: '-1' }), ConfigError);
    assert.throws(() => loadConfig({ ...TEST_ENV, RECONCILE_INTERVAL_MINUTES: 'soon' }), ConfigError);
  });

  it('defaults the bell to a 90 deg rest, 45 deg strike, 250 ms hold', () => {
    const { bell } = loadConfig(TEST_ENV);
    assert.deepEqual(bell, { restAngle: 90, strikeAngle: 45, holdMs: 250 });
  });

  it('makes both bell positions configurable', () => {
    const { bell } = loadConfig({
      ...TEST_ENV,
      BELL_REST_ANGLE: '80',
      BELL_STRIKE_ANGLE: '150',
      BELL_HOLD_MS: '400',
    });
    assert.deepEqual(bell, { restAngle: 80, strikeAngle: 150, holdMs: 400 });
  });

  it('rejects bell angles outside the servo travel range', () => {
    assert.throws(() => loadConfig({ ...TEST_ENV, BELL_STRIKE_ANGLE: '400' }), ConfigError);
    assert.throws(() => loadConfig({ ...TEST_ENV, BELL_REST_ANGLE: '-5' }), ConfigError);
  });

  it('rejects a strike angle equal to the rest angle — that would never move', () => {
    assert.throws(
      () => loadConfig({ ...TEST_ENV, BELL_REST_ANGLE: '90', BELL_STRIKE_ANGLE: '90' }),
      ConfigError,
    );
  });

  it('lists every missing required variable in one error', () => {
    const err = catchSync(() => loadConfig({}), ConfigError);
    for (const key of [
      'WEBHOOK_SECRET',
      'JETTYD_BASE_URL',
      'JETTYD_API_TOKEN',
      'JETTYD_DEVICE_ID',
      'POSTHOG_API_KEY',
      'POSTHOG_PROJECT_IDS',
    ]) {
      assert.match(err.message, new RegExp(key), `expected ${key} to be reported`);
    }
  });

  it('rejects a webhook secret too short to be worth having', () => {
    assert.throws(() => loadConfig({ ...TEST_ENV, WEBHOOK_SECRET: 'short' }), ConfigError);
  });

  it('strips a trailing slash from the Jettyd base URL', () => {
    const config = loadConfig({ ...TEST_ENV, JETTYD_BASE_URL: 'https://api.jettyd.example/' });
    assert.equal(config.jettyd.baseUrl, 'https://api.jettyd.example');
  });

  it('drives one combined device — a single device id, used for both commands', () => {
    const config = loadConfig(TEST_ENV);
    assert.equal(config.jettyd.deviceId, TEST_ENV.JETTYD_DEVICE_ID);
    assert.equal(Object.keys(config.jettyd).filter((k) => k.endsWith('DeviceId')).length, 0);
  });

  it('never exposes secrets through the redacted summary', () => {
    const summary = JSON.stringify(loadConfig(TEST_ENV).redactedSummary());
    assert.doesNotMatch(summary, /test-webhook-secret|jettyd-token-abc|phx_test_key/);
  });
});
