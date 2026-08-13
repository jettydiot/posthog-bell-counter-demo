/**
 * The exact bytes we put on the wire to the Jettyd public command API.
 * These assertions are deliberately literal — the firmware drivers parse these
 * field names, and a rename here is a silent no-op on the bench.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createJettydClient, JettydCommandError } from '../src/jettyd.js';
import { captureLogger, catchAsync, jsonResponse, mockFetch, testConfig } from './helpers.js';

function buildClient(fetchImpl, env) {
  const config = testConfig(env);
  const { logger, records } = captureLogger();
  return { client: createJettydClient(config, { fetch: fetchImpl, logger }), config, records };
}

const DEVICE_ID = '11111111-2222-3333-4444-555555555555';
const COMMANDS_URL = `https://api.jettyd.example/v1/devices/${DEVICE_ID}/commands`;

describe('servo.rotate — the bell strike', () => {
  it('posts the standard command envelope to the device command endpoint', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl);

    await client.ringBell();

    const [call] = fetchImpl.calls;
    assert.equal(call.url, COMMANDS_URL);
    assert.equal(call.method, 'POST');
    assert.deepEqual(call.body, {
      command_type: 'servo.rotate',
      payload: { angle: 45, hold_ms: 250 },
    });
  });

  it('uses the configured strike position and hold', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl, {
      BELL_REST_ANGLE: '100',
      BELL_STRIKE_ANGLE: '160',
      BELL_HOLD_MS: '500',
    });

    await client.ringBell();

    assert.deepEqual(fetchImpl.calls[0].body, {
      command_type: 'servo.rotate',
      payload: { angle: 160, hold_ms: 500 },
    });
  });

  it('sends the bearer token and a JSON content type', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl);

    await client.ringBell();

    assert.equal(fetchImpl.calls[0].headers.Authorization, 'Bearer jettyd-token-abc');
    assert.equal(fetchImpl.calls[0].headers['Content-Type'], 'application/json');
  });

  it('raises JettydCommandError on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ 'jettyd:servo.rotate': jsonResponse(502, { error: 'gateway' }) });
    const { client } = buildClient(fetchImpl);

    const err = await catchAsync(() => client.ringBell(), JettydCommandError);
    assert.equal(err.status, 502);
    assert.doesNotMatch(err.message, /jettyd-token-abc/);
  });
});

describe('display.set — the counter', () => {
  it('posts the count as the payload value on the same device', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl);

    await client.setDisplay(24);

    const [call] = fetchImpl.calls;
    assert.equal(call.url, COMMANDS_URL, 'display must target the same combined device');
    assert.deepEqual(call.body, {
      command_type: 'display.set',
      payload: { value: 24 },
    });
  });

  it('sends 0 as a number, not an empty string', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl);

    await client.setDisplay(0);

    assert.deepEqual(fetchImpl.calls[0].body.payload, { value: 0 });
  });

  it('refuses to render anything that is not a non-negative integer', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl);

    for (const bad of [-1, 1.5, NaN, '7', null, undefined]) {
      await assert.rejects(() => client.setDisplay(bad), /count/);
    }
    assert.deepEqual(fetchImpl.calls, []);
  });

  it('raises JettydCommandError on a non-2xx response', async () => {
    const fetchImpl = mockFetch({ 'jettyd:display.set': jsonResponse(404, { error: 'no device' }) });
    const { client } = buildClient(fetchImpl);

    const err = await catchAsync(() => client.setDisplay(3), JettydCommandError);
    assert.equal(err.status, 404);
  });
});

describe('one combined device', () => {
  it('sends both commands to the identical URL', async () => {
    const fetchImpl = mockFetch();
    const { client } = buildClient(fetchImpl);

    await client.ringBell();
    await client.setDisplay(1);

    const [servo, display] = fetchImpl.calls;
    assert.equal(servo.url, display.url);
  });
});
