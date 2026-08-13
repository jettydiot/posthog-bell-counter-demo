import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRequestHandler } from '../src/server.js';
import { safeCompare } from '../src/secret.js';
import { createBellRunner } from '../src/runner.js';
import { createJettydClient } from '../src/jettyd.js';
import { createPostHogClient } from '../src/posthog.js';
import {
  MockResponse,
  buildRequest,
  captureLogger,
  mockFetch,
  posthogCounts,
  testConfig,
} from './helpers.js';

function buildHandler(overrides = {}) {
  const config = testConfig(overrides.env);
  const fetchImpl = overrides.fetch ?? mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
  const { logger, records } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  const runner = createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });

  // The handler answers 202 and runs afterwards, so a test that wants to assert
  // on what the run *did* has to wait for it. Capturing the promise the handler
  // itself creates keeps that wait exact — no polling, no arbitrary flushes.
  const runs = [];
  const spy = {
    ...runner,
    trigger: (reason) => {
      const run = runner.trigger(reason);
      runs.push(run);
      return run;
    },
  };

  const handler = createRequestHandler({ config, runner: spy, logger, startedAt: Date.now() });
  return { handler, fetchImpl, records, runner: spy, config, settle: () => Promise.all(runs) };
}

async function post(handler, headers, body = '{"event":"device_claimed"}') {
  const res = new MockResponse();
  await handler(buildRequest('POST', '/webhook/posthog', headers, body), res);
  return res;
}

describe('webhook authentication', () => {
  it('accepts a request carrying the correct shared secret', async () => {
    const { handler, fetchImpl, settle } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'test-webhook-secret' });

    assert.equal(res.statusCode, 202);
    await settle();
    assert.ok(fetchImpl.kinds().includes('jettyd:servo.rotate'));
  });

  it('rejects a wrong secret with 401 and touches no hardware', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'not-the-secret-at-all' });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('rejects a missing secret with 401 and touches no hardware', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = await post(handler, {});

    assert.equal(res.statusCode, 401);
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('rejects a secret that is a prefix of the real one', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'test-webhook-secre' });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('rejects a secret with trailing padding', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'test-webhook-secretX' });

    assert.equal(res.statusCode, 401);
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('compares the secret in constant time regardless of length', () => {
    // A length mismatch must not short-circuit into a cheap `false` before the
    // comparison runs; both branches go through timingSafeEqual.
    assert.equal(safeCompare('abcdef', 'abcdef'), true);
    assert.equal(safeCompare('abcdef', 'abcdeg'), false);
    assert.equal(safeCompare('abcdef', 'abc'), false);
    assert.equal(safeCompare('abcdef', ''), false);
    assert.equal(safeCompare(undefined, 'abcdef'), false);
    assert.equal(safeCompare('abcdef', undefined), false);
  });

  it('never echoes the expected secret in the response or the logs', async () => {
    const { handler, records } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'wrong' });

    assert.doesNotMatch(res.body, /test-webhook-secret/);
    assert.doesNotMatch(JSON.stringify(records), /test-webhook-secret/);
  });

  it('logs the rejection so a misconfigured destination is visible', async () => {
    const { handler, records } = buildHandler();
    await post(handler, { 'x-webhook-secret': 'wrong' });

    const rejected = records.filter((r) => r.event === 'webhook.rejected');
    assert.equal(rejected.length, 1);
    assert.equal(rejected[0].level, 'warn');
  });

  it('rejects a non-POST request to the webhook path', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = new MockResponse();
    await handler(
      buildRequest('GET', '/webhook/posthog', { 'x-webhook-secret': 'test-webhook-secret' }),
      res,
    );

    assert.equal(res.statusCode, 405);
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('returns 400 for a malformed body without ringing', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'test-webhook-secret' }, 'not json');

    assert.equal(res.statusCode, 400);
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('returns 413 for a body over the 256 KiB cap, without ringing', async () => {
    const { handler, fetchImpl } = buildHandler();
    const oversized = JSON.stringify({ event: 'device_claimed', pad: 'x'.repeat(1024 * 256) });
    const res = await post(handler, { 'x-webhook-secret': 'test-webhook-secret' }, oversized);

    assert.equal(res.statusCode, 413);
    assert.deepEqual(fetchImpl.calls, [], 'an oversized delivery must never reach the hardware');
  });

  it('accepts a body that sits just under the cap', async () => {
    const { handler, settle } = buildHandler();
    // Proves the 413 above is the cap talking, not any large body failing.
    const padding = 1024 * 256 - JSON.stringify({ event: 'device_claimed', pad: '' }).length;
    const res = await post(
      handler,
      { 'x-webhook-secret': 'test-webhook-secret' },
      JSON.stringify({ event: 'device_claimed', pad: 'x'.repeat(padding) }),
    );

    assert.equal(res.statusCode, 202);
    await settle();
  });

  it('returns 404 for an unknown path', async () => {
    const { handler } = buildHandler();
    const res = new MockResponse();
    await handler(buildRequest('POST', '/nope', {}), res);
    assert.equal(res.statusCode, 404);
  });
});
