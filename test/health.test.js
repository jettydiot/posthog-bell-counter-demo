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

function buildHandler(fetchImpl = mockFetch(posthogCounts({ 131280: 4, 214227: 3, 218818: 2 }))) {
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

async function get(handler, path = '/healthz') {
  const res = new MockResponse();
  await handler(buildRequest('GET', path, {}), res);
  return res;
}

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

  it('reports the configuration without ever exposing a secret', async () => {
    const { handler } = buildHandler();
    const res = await get(handler);

    assert.deepEqual(res.json().posthog_projects, ['131280', '214227', '218818']);
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
    const fetchImpl = mockFetch({ 'posthog:214227': jsonResponse(500, {}) });
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
