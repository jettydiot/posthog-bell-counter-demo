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
  const fetchImpl = overrides.fetch ?? mockFetch(posthogCounts({ 131280: 1, 214227: 1, 218818: 1 }));
  const { logger, records } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  const runner = createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });
  const handler = createRequestHandler({ config, runner, logger, startedAt: Date.now() });
  return { handler, fetchImpl, records, runner, config };
}

async function post(handler, headers, body = '{"event":"device_claimed"}') {
  const res = new MockResponse();
  await handler(buildRequest('POST', '/webhook/posthog', headers, body), res);
  return res;
}

describe('webhook authentication', () => {
  it('accepts a request carrying the correct shared secret', async () => {
    const { handler, fetchImpl } = buildHandler();
    const res = await post(handler, { 'x-webhook-secret': 'test-webhook-secret' });

    assert.equal(res.statusCode, 200);
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

  it('returns 404 for an unknown path', async () => {
    const { handler } = buildHandler();
    const res = new MockResponse();
    await handler(buildRequest('POST', '/nope', {}), res);
    assert.equal(res.statusCode, 404);
  });
});
