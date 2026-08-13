/**
 * Shared test helpers.
 *
 * Everything the service touches from the outside world (`fetch`, the clock,
 * timers, the log sink) is injected, so no test monkey-patches a global and no
 * test needs a network, a device, or a real timer.
 */

import { loadConfig } from '../src/config.js';
import { createLogger } from '../src/logger.js';

export const TEST_ENV = {
  WEBHOOK_SECRET: 'test-webhook-secret',
  JETTYD_BASE_URL: 'https://api.jettyd.example',
  JETTYD_API_TOKEN: 'jettyd-token-abc',
  JETTYD_DEVICE_ID: '11111111-2222-3333-4444-555555555555',
  POSTHOG_API_KEY: 'phx_test_key',
};

export function testConfig(overrides = {}) {
  return loadConfig({ ...TEST_ENV, ...overrides });
}

/** Logger that captures records instead of writing to stdout. */
export function captureLogger(level = 'debug') {
  const records = [];
  const logger = createLogger({
    level,
    sink: (line) => records.push(JSON.parse(line)),
    now: () => new Date('2026-08-13T00:00:00.000Z'),
  });
  return { logger, records, find: (event) => records.filter((r) => r.event === event) };
}

/**
 * Scriptable `fetch` double.
 *
 * `routes` maps a matcher to a handler. Every call is recorded in `calls`
 * in invocation order, which is what the ordering tests assert on.
 */
export function mockFetch(routes = {}) {
  const calls = [];

  const fn = async (url, options = {}) => {
    const body = options.body ? JSON.parse(options.body) : null;
    const call = {
      url: String(url),
      method: options.method,
      headers: options.headers ?? {},
      body,
      kind: classify(String(url), body),
    };
    calls.push(call);

    const handler = routes[call.kind];
    if (typeof handler === 'function') {
      return handler(call);
    }
    if (handler !== undefined) {
      return handler;
    }
    return jsonResponse(200, defaultResponseFor(call));
  };

  fn.calls = calls;
  fn.kinds = () => calls.map((c) => c.kind);
  return fn;
}

/** Label each outbound request so tests can assert on a readable sequence. */
function classify(url, body) {
  if (url.includes('/query')) {
    const match = url.match(/projects\/(\d+)/);
    return `posthog:${match ? match[1] : 'unknown'}`;
  }
  if (url.includes('/commands')) {
    return `jettyd:${body?.command_type ?? 'unknown'}`;
  }
  return `other:${url}`;
}

function defaultResponseFor(call) {
  if (call.kind.startsWith('posthog:')) return { results: [[0]] };
  return { id: 'cmd-1', status: 'queued' };
}

export function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    statusText: `HTTP ${status}`,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
  };
}

/** PostHog `fetch` route returning a per-project count. */
export function posthogCounts(counts) {
  const routes = {};
  for (const [projectId, value] of Object.entries(counts)) {
    routes[`posthog:${projectId}`] =
      value instanceof Error
        ? () => {
            throw value;
          }
        : typeof value === 'object'
          ? value
          : jsonResponse(200, { results: [[value]] });
  }
  return routes;
}

// ── HTTP doubles ─────────────────────────────────────────────────────────────

export function buildRequest(method, url, headers = {}, body = '') {
  return {
    method,
    url,
    headers: { 'content-type': 'application/json', ...headers },
    [Symbol.asyncIterator]: async function* () {
      if (body) yield Buffer.from(body);
    },
  };
}

export class MockResponse {
  constructor() {
    this.statusCode = null;
    this.headers = {};
    this.body = '';
    this.ended = false;
  }

  setHeader(key, value) {
    this.headers[key.toLowerCase()] = value;
  }

  writeHead(code, headers = {}) {
    this.statusCode = code;
    for (const [key, value] of Object.entries(headers)) this.setHeader(key, value);
    return this;
  }

  end(body) {
    this.body = body ?? '';
    this.ended = true;
  }

  json() {
    return JSON.parse(this.body);
  }
}

/** Resolve after all currently queued microtasks/immediates have run. */
export function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

/**
 * `assert.throws` / `assert.rejects` resolve to `undefined`, so they cannot be
 * used to inspect the error. These assert the type and hand the error back.
 */
export function catchSync(fn, expectedType) {
  try {
    fn();
  } catch (err) {
    assertType(err, expectedType);
    return err;
  }
  throw new Error('expected the call to throw, but it returned normally');
}

export async function catchAsync(fn, expectedType) {
  try {
    await fn();
  } catch (err) {
    assertType(err, expectedType);
    return err;
  }
  throw new Error('expected the call to reject, but it resolved');
}

function assertType(err, expectedType) {
  if (expectedType && !(err instanceof expectedType)) {
    throw new Error(`expected ${expectedType.name}, got ${err?.constructor?.name}: ${err?.message}`);
  }
}

/** A promise plus its resolvers, for pinning an in-flight request open. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}
