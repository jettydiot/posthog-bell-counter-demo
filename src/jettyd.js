/**
 * The Jettyd public command API.
 *
 *   POST {base}/v1/devices/{device_id}/commands
 *   Authorization: Bearer <api key or JWT>
 *   { "command_type": "<instance>.<action>", "payload": { ... } }
 *
 * Both commands go to the *same* device. The servo and the MAX7219 panel are
 * two drivers registered by one ESP32-C6, so there is one device id, one
 * endpoint and one command envelope shape.
 *
 * `servo.rotate` is the out-and-back primitive: the firmware drives the horn to
 * `angle`, holds it for `hold_ms`, then returns to the servo's configured
 * `home_angle`. That home angle is the bell's rest position — see
 * firmware/device.yaml, and BELL_REST_ANGLE, which must agree with it.
 */

import { postJson, readJson } from './http.js';
import { redact } from './secret.js';

export class JettydCommandError extends Error {
  constructor(commandType, status, detail) {
    super(`jettyd ${commandType} failed: HTTP ${status}${detail ? ` — ${detail}` : ''}`);
    this.name = 'JettydCommandError';
    this.commandType = commandType;
    this.status = status;
  }
}

export function createJettydClient(config, { fetch: fetchImpl, logger }) {
  const { baseUrl, token, deviceId, timeoutMs } = config.jettyd;
  const commandUrl = `${baseUrl}/v1/devices/${deviceId}/commands`;

  async function send(commandType, payload) {
    const response = await postJson(fetchImpl, commandUrl, {
      headers: { Authorization: `Bearer ${token}` },
      body: { command_type: commandType, payload },
      timeoutMs,
    });

    if (!response.ok) {
      const body = await readJson(response);
      const detail = redact(body?.error ?? body?.detail ?? '', token);
      throw new JettydCommandError(commandType, response.status, detail);
    }

    // Nothing reads the body of an accepted command, but an unread body pins the
    // connection open until the timeout fires. Release it, and hand callers a
    // plain result rather than a live Response they would have to remember to
    // drain themselves.
    try {
      await response.body?.cancel();
    } catch {
      // A body that will not cancel is not worth failing an accepted command for.
    }

    logger.debug('jettyd.command_accepted', { command_type: commandType, payload });
    return { status: response.status };
  }

  return {
    commandUrl,

    /** One out-and-back swing: strike position, hold, then home. */
    ringBell() {
      return send('servo.rotate', {
        angle: config.bell.strikeAngle,
        hold_ms: config.bell.holdMs,
      });
    },

    /**
     * Render the authoritative count. Guarded because a bad value here is a
     * garbled panel that looks like a real reading.
     */
    setDisplay(count) {
      if (typeof count !== 'number' || !Number.isInteger(count) || count < 0) {
        return Promise.reject(
          new TypeError(`display count must be a non-negative integer (got ${String(count)})`),
        );
      }
      return send('display.set', { value: count });
    },
  };
}
