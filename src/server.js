/**
 * The HTTP surface: one webhook, one health probe, nothing else.
 *
 * Built on `node:http` directly — a framework would be more dependency than
 * this needs, and the routing table fits in a paragraph.
 */

import { createServer as createHttpServer } from 'node:http';

import { safeCompare } from './secret.js';

const WEBHOOK_PATH = '/webhook/posthog';
const HEALTH_PATHS = new Set(['/healthz', '/health']);
const MAX_BODY_BYTES = 1024 * 256;

export function createRequestHandler({
  config,
  runner,
  logger,
  startedAt = Date.now(),
  version = '1.0.0',
  now = () => Date.now(),
}) {
  return async function handler(req, res) {
    const path = String(req.url ?? '/').split('?')[0];

    if (HEALTH_PATHS.has(path)) {
      if (req.method !== 'GET' && req.method !== 'HEAD') {
        return send(res, 405, { error: 'method not allowed' });
      }
      return send(res, 200, healthBody({ config, runner, startedAt, version, now }));
    }

    if (path === WEBHOOK_PATH) {
      if (req.method !== 'POST') {
        return send(res, 405, { error: 'method not allowed' });
      }
      return handleWebhook(req, res, { config, runner, logger });
    }

    return send(res, 404, { error: 'not found' });
  };
}

async function handleWebhook(req, res, { config, runner, logger }) {
  // Authenticate before reading the body: an unauthenticated caller should not
  // be able to make us buffer anything, and must never reach the hardware.
  const provided = req.headers['x-webhook-secret'];
  if (!safeCompare(typeof provided === 'string' ? provided : '', config.webhookSecret)) {
    logger.warn('webhook.rejected', {
      reason: provided ? 'secret mismatch' : 'secret missing',
      remote: req.socket?.remoteAddress ?? null,
    });
    return send(res, 401, { error: 'unauthorized' });
  }

  let raw;
  try {
    raw = await readBody(req);
  } catch (err) {
    logger.warn('webhook.body_error', { error: String(err?.message ?? err) });
    return send(res, 413, { error: 'payload too large' });
  }

  let payload;
  try {
    payload = raw.length === 0 ? {} : JSON.parse(raw);
  } catch {
    // A malformed body means a misconfigured destination, not a claim event.
    logger.warn('webhook.malformed', { bytes: raw.length });
    return send(res, 400, { error: 'body must be JSON' });
  }

  // `event_name`, not `event` — every log record already uses `event` for the
  // log event name, and shadowing it would rewrite 'webhook.accepted'.
  logger.info('webhook.accepted', {
    event_name: payload?.event ?? payload?.data?.event ?? null,
    bytes: raw.length,
  });

  const result = await runner.trigger('webhook');

  return send(res, 200, {
    ok: result.ok,
    run_id: result.runId,
    coalesced_requests: result.coalesced,
    bell: result.bell,
    count: result.count,
    displayed: result.displayed,
    error: result.error,
  });
}

function healthBody({ config, runner, startedAt, version, now }) {
  const { busy, lastRun } = runner.stats();
  const summary = config.redactedSummary();

  return {
    status: lastRun && !lastRun.ok ? 'degraded' : 'ok',
    version,
    uptime_seconds: Math.floor((now() - startedAt) / 1000),
    busy,
    reconcile_interval_minutes: summary.reconcile_interval_minutes,
    posthog_host: summary.posthog_host,
    posthog_projects: summary.posthog_projects,
    posthog_event: summary.posthog_event,
    jettyd_base_url: summary.jettyd_base_url,
    device_id: summary.device_id,
    bell: summary.bell,
    last_run: lastRun
      ? {
          run_id: lastRun.runId,
          at: lastRun.at,
          trigger: lastRun.trigger,
          kind: lastRun.kind,
          ok: lastRun.ok,
          bell_ok: lastRun.bell.ok,
          count: lastRun.count,
          displayed: lastRun.displayed,
          duration_ms: lastRun.durationMs,
          error: lastRun.error,
        }
      : null,
  };
}

async function readBody(req) {
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req) {
    bytes += chunk.length;
    if (bytes > MAX_BODY_BYTES) throw new Error('body exceeds 256 KiB');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function send(res, status, body) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(payload),
    'Cache-Control': 'no-store',
  });
  res.end(payload);
}

export function startHttpServer({ handler, host, port, logger }) {
  const server = createHttpServer((req, res) => {
    handler(req, res).catch((err) => {
      logger.error('server.unhandled', { error: String(err?.message ?? err) });
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
      else res.end();
    });
  });

  server.listen(port, host, () => logger.info('server.listening', { host, port }));
  return server;
}
