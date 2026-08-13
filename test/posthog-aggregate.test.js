import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createPostHogClient, PostHogQueryError } from '../src/posthog.js';
import {
  captureLogger,
  catchAsync,
  jsonResponse,
  mockFetch,
  posthogCounts,
  testConfig,
} from './helpers.js';

function buildClient(fetchImpl, config = testConfig()) {
  const { logger, records } = captureLogger();
  return { client: createPostHogClient(config, { fetch: fetchImpl, logger }), records };
}

describe('PostHog aggregate — authoritative current-month count', () => {
  it('sums device_claimed across all three projects', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 12, 100002: 7, 100003: 5 }));
    const { client } = buildClient(fetchImpl);

    const result = await client.fetchMonthlyTotal();

    assert.equal(result.total, 24);
    assert.deepEqual(result.perProject, { 100001: 12, 100002: 7, 100003: 5 });
  });

  it('returns 0 when every project is empty', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 0, 100002: 0, 100003: 0 }));
    const { client } = buildClient(fetchImpl);
    assert.equal((await client.fetchMonthlyTotal()).total, 0);
  });

  it('scopes the query to the current month and the device_claimed event', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
    const { client } = buildClient(fetchImpl);

    await client.fetchMonthlyTotal();

    for (const call of fetchImpl.calls) {
      assert.equal(call.body.query.kind, 'HogQLQuery');
      assert.match(call.body.query.query, /device_claimed/);
      assert.match(call.body.query.query, /toStartOfMonth/);
    }
  });

  it('queries each configured project exactly once, at its own project endpoint', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
    const { client } = buildClient(fetchImpl);

    await client.fetchMonthlyTotal();

    assert.deepEqual(
      fetchImpl.calls.map((c) => c.url),
      [
        'https://eu.posthog.com/api/projects/100001/query/',
        'https://eu.posthog.com/api/projects/100002/query/',
        'https://eu.posthog.com/api/projects/100003/query/',
      ],
    );
  });

  it('authenticates with the personal API key as a bearer token', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 1, 100003: 1 }));
    const { client } = buildClient(fetchImpl);

    await client.fetchMonthlyTotal();

    assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer phx_test_key');
  });
});

describe('PostHog aggregate — a partial answer is not an answer', () => {
  it('throws when one project returns a non-2xx status', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 100001: 12, 100003: 5 }),
      'posthog:100002': jsonResponse(503, { detail: 'unavailable' }),
    });
    const { client } = buildClient(fetchImpl);

    const err = await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);
    assert.match(err.message, /100002/);
  });

  it('throws when one project connection fails outright', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 100001: 12, 100003: 5 }),
      'posthog:100002': () => {
        throw new Error('ECONNRESET');
      },
    });
    const { client } = buildClient(fetchImpl);

    await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);
  });

  it('throws when one project returns an unparseable result shape', async () => {
    const fetchImpl = mockFetch({
      ...posthogCounts({ 100001: 12, 100003: 5 }),
      'posthog:100002': jsonResponse(200, { results: [] }),
    });
    const { client } = buildClient(fetchImpl);

    await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);
  });

  it('throws when a count is negative or not a number', async () => {
    for (const bad of [-1, 'seven', null]) {
      const fetchImpl = mockFetch({
        ...posthogCounts({ 100001: 12, 100003: 5 }),
        'posthog:100002': jsonResponse(200, { results: [[bad]] }),
      });
      const { client } = buildClient(fetchImpl);
      await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);
    }
  });

  it('still queries every project so the error names all of the broken ones', async () => {
    const fetchImpl = mockFetch({
      'posthog:100001': jsonResponse(500, {}),
      'posthog:100002': jsonResponse(200, { results: [[7]] }),
      'posthog:100003': jsonResponse(401, {}),
    });
    const { client } = buildClient(fetchImpl);

    const err = await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);
    assert.equal(fetchImpl.calls.length, 3);
    assert.match(err.message, /100001/);
    assert.match(err.message, /100003/);
    assert.deepEqual(
      err.failures.map((f) => f.projectId),
      ['100001', '100003'],
    );
  });

  it('never leaks the API key into the error message', async () => {
    // The thrown error carries the key, the way a transport error quoting the
    // request URL or headers would. Without it in the fixture the assertion
    // below passes whether redaction works or not.
    const fetchImpl = mockFetch({
      'posthog:100001': () => {
        throw new Error('connect failed for Authorization: Bearer phx_test_key');
      },
    });
    const { client } = buildClient(fetchImpl);

    const err = await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);
    assert.match(err.message, /connect failed/, 'the diagnosable part of the reason survives');
    assert.doesNotMatch(err.message, /phx_test_key/);
    assert.match(err.message, /\[redacted\]/);
  });

  it('redacts the API key in the per-project failure log as well', async () => {
    const fetchImpl = mockFetch({
      'posthog:100001': () => {
        throw new Error('connect failed for Authorization: Bearer phx_test_key');
      },
    });
    const { client, records } = buildClient(fetchImpl);

    await catchAsync(() => client.fetchMonthlyTotal(), PostHogQueryError);

    assert.doesNotMatch(JSON.stringify(records), /phx_test_key/);
  });
});
