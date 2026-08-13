/**
 * The outbound request deadline.
 *
 * The timeout has to cover the *whole* exchange, not just the wait for response
 * headers. A peer that sends a status line and then stalls mid-body would
 * otherwise leave the body read pending indefinitely: the runner holds its
 * single slot, the panel never updates, and nothing ever times out.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { postJson, readJson } from '../src/http.js';

describe('postJson', () => {
  it('passes an abort signal to fetch', async () => {
    let seen;
    await postJson(async (_url, options) => ((seen = options), { ok: true }), 'https://x.test', {
      body: { a: 1 },
      timeoutMs: 50,
    });

    assert.ok(seen.signal, 'no signal reached fetch');
    assert.equal(seen.signal.aborted, false);
  });

  it('serialises the body and sets the JSON content type', async () => {
    let seen;
    await postJson(async (_url, options) => ((seen = options), { ok: true }), 'https://x.test', {
      headers: { Authorization: 'Bearer t' },
      body: { command_type: 'servo.rotate' },
    });

    assert.equal(seen.method, 'POST');
    assert.equal(seen.headers['Content-Type'], 'application/json');
    assert.equal(seen.headers.Authorization, 'Bearer t');
    assert.deepEqual(JSON.parse(seen.body), { command_type: 'servo.rotate' });
  });

  it('keeps the deadline live after the response headers arrive', async () => {
    // The regression this guards: clearing a timer in a `finally` once fetch
    // resolves leaves the body read with no deadline at all.
    let signal;
    const response = await postJson(
      async (_url, options) => {
        signal = options.signal;
        return { ok: true, status: 200 };
      },
      'https://x.test',
      { body: {}, timeoutMs: 20 },
    );

    assert.equal(response.ok, true);
    assert.equal(signal.aborted, false, 'the deadline must not be cancelled by headers arriving');

    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.equal(signal.aborted, true, 'a stalled body must still hit the deadline');
    assert.equal(signal.reason?.name, 'TimeoutError');
  });

  it('aborts a body that never finishes arriving', async () => {
    const stalled = await postJson(
      async (_url, options) => ({
        ok: true,
        status: 200,
        json: () =>
          new Promise((_resolve, reject) => {
            options.signal.addEventListener('abort', () => reject(options.signal.reason), {
              once: true,
            });
          }),
      }),
      'https://x.test',
      { body: {}, timeoutMs: 20 },
    );

    // readJson swallows the failure into null rather than masking the status,
    // but the point is that it *settles* instead of hanging forever.
    assert.equal(await readJson(stalled), null);
  });
});

describe('readJson', () => {
  it('returns null rather than letting a malformed body mask the status', async () => {
    const response = {
      status: 502,
      json: async () => {
        throw new SyntaxError('Unexpected token < in JSON');
      },
    };
    assert.equal(await readJson(response), null);
  });

  it('returns the parsed body when there is one', async () => {
    assert.deepEqual(await readJson({ json: async () => ({ ok: 1 }) }), { ok: 1 });
  });
});
