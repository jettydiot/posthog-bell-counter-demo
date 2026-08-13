import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createRequestHandler } from '../src/server.js';
import { createBellRunner } from '../src/runner.js';
import { createJettydClient } from '../src/jettyd.js';
import { createPostHogClient } from '../src/posthog.js';
import {
  MockResponse,
  buildRequest,
  captureLogger,
  jsonResponse,
  mockFetch,
  posthogCounts,
  testConfig,
} from './helpers.js';

function buildHandler(fetchImpl = mockFetch(posthogCounts({ 100001: 4, 100002: 3, 100003: 2 }))) {
  const config = testConfig();
  const { logger } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  const runner = createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });
  const handler = createRequestHandler({
    config,
    runner,
    logger,
    startedAt: Date.now() - 5000,
    version: '1.0.0',
  });
  return { handler, runner, fetchImpl };
}

async function get(handler, path = '/healthz', headers = {}) {
  const res = new MockResponse();
  await handler(buildRequest('GET', path, headers), res);
  return res;
}

const AUTHED = { 'x-webhook-secret': 'test-webhook-secret' };

describe('health endpoint', () => {
  it('answers 200 with a JSON body', async () => {
    const { handler } = buildHandler();
    const res = await get(handler);

    assert.equal(res.statusCode, 200);
    assert.equal(res.headers['content-type'], 'application/json');
    assert.equal(res.json().status, 'ok');
  });

  it('needs no authentication — it is a liveness probe', async () => {
    const { handler } = buildHandler();
    const res = await get(handler);
    assert.equal(res.statusCode, 200);
  });

  it('reports uptime, version and the reconcile schedule', async () => {
    const { handler } = buildHandler();
    const body = (await get(handler)).json();

    assert.ok(body.uptime_seconds >= 5);
    assert.equal(body.version, '1.0.0');
    assert.equal(body.reconcile_interval_minutes, 15);
  });

  it('reports the configuration to an authenticated caller, never a secret', async () => {
    const { handler } = buildHandler();
    const res = await get(handler, '/healthz', AUTHED);

    assert.deepEqual(res.json().posthog_projects, ['100001', '100002', '100003']);
    assert.doesNotMatch(res.body, /test-webhook-secret|jettyd-token-abc|phx_test_key/);
  });

  it('reports the last run once one has happened', async () => {
    const { handler, runner } = buildHandler();
    await runner.trigger('webhook');

    const body = (await get(handler)).json();
    assert.equal(body.last_run.count, 9);
    assert.equal(body.last_run.displayed, true);
    assert.equal(body.last_run.trigger, 'webhook');
    assert.ok(body.last_run.at);
  });

  it('reports null for the last run before anything has run', async () => {
    const { handler } = buildHandler();
    assert.equal((await get(handler)).json().last_run, null);
  });

  it('surfaces a degraded state after a failed run', async () => {
    const fetchImpl = mockFetch({ 'posthog:100002': jsonResponse(500, {}) });
    const { handler, runner } = buildHandler(fetchImpl);
    await runner.trigger('webhook');

    const res = await get(handler);
    const body = res.json();

    assert.equal(res.statusCode, 200, 'the process is alive even when PostHog is not');
    assert.equal(body.status, 'degraded');
    assert.equal(body.last_run.ok, false);
    assert.equal(body.last_run.error.stage, 'query');
  });

  it('exposes whether a run is in flight', async () => {
    const { handler } = buildHandler();
    assert.equal((await get(handler)).json().busy, false);
  });

  it('is also served at /health', async () => {
    const { handler } = buildHandler();
    assert.equal((await get(handler, '/health')).statusCode, 200);
  });
});

/**
 * The probe is unauthenticated by design, which means anything in its body is
 * public if the service is. The device id and the project ids are the inputs to
 * the Jettyd command API and the PostHog query API, so they are not free to
 * hand out to an anonymous caller.
 */
describe('health endpoint — what an anonymous caller is told', () => {
  const IDENTIFIERS = ['device_id', 'jettyd_base_url', 'posthog_projects', 'posthog_event', 'posthog_host'];

  it('omits every deployment identifier without the shared secret', async () => {
    const { handler } = buildHandler();
    const body = (await get(handler)).json();

    for (const key of IDENTIFIERS) {
      assert.equal(key in body, false, `${key} must not be served to an anonymous caller`);
    }
  });

  it('still answers the liveness question anonymously', async () => {
    const { handler } = buildHandler();
    const body = (await get(handler)).json();

    assert.equal(body.status, 'ok');
    assert.equal(body.busy, false);
    assert.ok('uptime_seconds' in body);
    assert.ok('version' in body);
    assert.ok('last_run' in body);
  });

  it('adds the identifiers once the caller presents the secret', async () => {
    const { handler } = buildHandler();
    const body = (await get(handler, '/healthz', AUTHED)).json();

    for (const key of IDENTIFIERS) {
      assert.equal(key in body, true, `${key} should be visible to an authenticated caller`);
    }
    assert.equal(body.device_id, '11111111-2222-3333-4444-555555555555');
  });

  it('treats a wrong secret as anonymous rather than as an error', async () => {
    // 401ing a liveness probe is how a healthy service gets restarted.
    const { handler } = buildHandler();
    const res = await get(handler, '/healthz', { 'x-webhook-secret': 'wrong' });

    assert.equal(res.statusCode, 200);
    assert.equal('device_id' in res.json(), false);
  });

  it('applies the same rule at /health', async () => {
    const { handler } = buildHandler();

    assert.equal('device_id' in (await get(handler, '/health')).json(), false);
    assert.equal('device_id' in (await get(handler, '/health', AUTHED)).json(), true);
  });

  it('leaks no identifier through the response text itself', async () => {
    const { handler } = buildHandler();
    const res = await get(handler);

    assert.doesNotMatch(res.body, /11111111-2222-3333-4444-555555555555/);
    assert.doesNotMatch(res.body, /100001|100002|100003/);
  });
});
