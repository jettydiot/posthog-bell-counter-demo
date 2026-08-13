/**
 * The webhook acknowledges, then runs.
 *
 * PostHog gives a destination a bounded window to answer before it treats the
 * delivery as failed and retries it. A run is a servo strike plus one query per
 * project, so answering only once the run finished put the response inside
 * retry range — and a retry landing after the first run completed is not
 * coalesced by the runner. It is a second strike for a single claim.
 *
 * So: 202 immediately, run afterwards, outcome in the logs and in /healthz.
 */

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
  deferred,
  flush,
  jsonResponse,
  mockFetch,
  posthogCounts,
  testConfig,
} from './helpers.js';

function build(fetchImpl) {
  const config = testConfig();
  const { logger, records } = captureLogger();
  const deps = { fetch: fetchImpl, logger };
  const runner = createBellRunner({
    config,
    jettyd: createJettydClient(config, deps),
    posthog: createPostHogClient(config, deps),
    logger,
  });

  const runs = [];
  const spy = {
    ...runner,
    trigger: (reason) => {
      const run = runner.trigger(reason);
      runs.push(run);
      return run;
    },
  };

  const handler = createRequestHandler({
    config,
    runner: spy,
    logger,
    startedAt: Date.now(),
    version: '1.0.0',
  });

  return {
    handler,
    runner,
    records,
    find: (event) => records.filter((r) => r.event === event),
    settle: () => Promise.all(runs),
  };
}

async function fire(handler) {
  const res = new MockResponse();
  await handler(
    buildRequest(
      'POST',
      '/webhook/posthog',
      { 'x-webhook-secret': 'test-webhook-secret' },
      '{"event":"device_claimed"}',
    ),
    res,
  );
  return res;
}

async function health(handler, headers = {}) {
  const res = new MockResponse();
  await handler(buildRequest('GET', '/healthz', headers), res);
  return res.json();
}

describe('the webhook acknowledges before the run finishes', () => {
  it('answers 202 while the strike is still in flight', async () => {
    const gate = deferred();
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body ?? '{}');
      if (body.command_type === 'servo.rotate') {
        await gate.promise;
        return jsonResponse(200, {});
      }
      if (String(url).includes('/query')) return jsonResponse(200, { results: [[1]] });
      return jsonResponse(200, {});
    };

    const { handler, settle } = build(fetchImpl);
    const res = await fire(handler);

    // The servo call has not returned, and the caller already has its answer.
    assert.equal(res.statusCode, 202);
    assert.equal(res.ended, true);

    gate.resolve();
    await settle();
  });

  it('acknowledges without the run outcome — there is none yet', async () => {
    const { handler, settle } = build(mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 })));
    const res = await fire(handler);

    assert.deepEqual(res.json(), { accepted: true });
    await settle();
  });

  it('still performs the whole run after acknowledging', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 4, 100002: 3, 100003: 2 }));
    const { handler, settle } = build(fetchImpl);

    await fire(handler);
    await settle();

    assert.deepEqual(fetchImpl.kinds(), [
      'jettyd:servo.rotate',
      'posthog:100001',
      'posthog:100002',
      'posthog:100003',
      'jettyd:display.set',
    ]);
  });

  it('keeps the outcome observable through /healthz last_run', async () => {
    const { handler, settle } = build(mockFetch(posthogCounts({ 100001: 4, 100002: 3, 100003: 2 })));

    await fire(handler);
    await settle();

    const body = await health(handler);
    assert.equal(body.last_run.count, 9);
    assert.equal(body.last_run.ok, true);
    assert.equal(body.last_run.trigger, 'webhook');
  });

  it('logs the settlement, since the response can no longer carry it', async () => {
    const { handler, settle, find } = build(
      mockFetch(posthogCounts({ 100001: 2, 100002: 0, 100003: 0 })),
    );

    await fire(handler);
    await settle();
    await flush();

    const [settled] = find('webhook.run_settled');
    assert.ok(settled, 'every acknowledged delivery must leave a settlement line');
    assert.equal(settled.ok, true);
    assert.equal(settled.count, 2);
    assert.equal(settled.displayed, true);
    assert.equal(settled.coalesced_requests, 1);
  });

  it('logs a failed run as a settlement too, and still answered 202', async () => {
    const { handler, settle, find } = build(mockFetch({ 'posthog:100002': jsonResponse(500, {}) }));

    const res = await fire(handler);
    await settle();
    await flush();

    assert.equal(res.statusCode, 202, 'a broken PostHog is not the sender’s problem');
    const [settled] = find('webhook.run_settled');
    assert.equal(settled.ok, false);
    assert.equal(settled.error.stage, 'query');
    assert.equal(settled.displayed, false);
  });

  it('reports degraded on /healthz after a failed run', async () => {
    const { handler, settle } = build(mockFetch({ 'posthog:100002': jsonResponse(500, {}) }));

    await fire(handler);
    await settle();

    assert.equal((await health(handler)).status, 'degraded');
  });

  it('coalesces a burst that arrives during a run into one follow-up strike', async () => {
    const gates = [];
    const kinds = [];
    const fetchImpl = async (url, options) => {
      const body = JSON.parse(options.body ?? '{}');
      const kind = String(url).includes('/query')
        ? 'posthog'
        : `jettyd:${body.command_type}`;
      kinds.push(kind);
      if (kind === 'jettyd:servo.rotate') {
        const gate = deferred();
        gates.push(gate);
        await gate.promise;
      }
      return jsonResponse(200, { results: [[1]] });
    };

    const { handler, settle } = build(fetchImpl);

    // Three deliveries land back to back; none of them waits for a run.
    const responses = [await fire(handler), await fire(handler), await fire(handler)];
    for (const res of responses) assert.equal(res.statusCode, 202);

    for (let i = 0; i < 8; i++) {
      while (gates.length) gates.shift().resolve();
      await flush();
    }
    await settle();

    assert.equal(
      kinds.filter((k) => k === 'jettyd:servo.rotate').length,
      2,
      'three deliveries during one run → the run plus a single coalesced follow-up',
    );
  });
});
