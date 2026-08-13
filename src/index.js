#!/usr/bin/env node
/**
 * Entry point: wire the pieces together, start listening, schedule reconcile.
 *
 * Every collaborator is constructed here and injected downwards, which is why
 * the tests never need a network, a device or a real timer.
 */

import { loadConfig, ConfigError } from './config.js';
import { createLogger } from './logger.js';
import { createJettydClient } from './jettyd.js';
import { createPostHogClient } from './posthog.js';
import { createBellRunner } from './runner.js';
import { createRequestHandler, startHttpServer } from './server.js';
import { startReconcileScheduler } from './scheduler.js';

const VERSION = '1.0.0';

function main() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (err) {
    if (err instanceof ConfigError) {
      // Before the logger exists, and the operator needs to read this.
      process.stderr.write(`${err.message}\n\nSee .env.example for the full list.\n`);
      process.exit(1);
    }
    throw err;
  }

  const logger = createLogger({ level: config.logLevel });
  logger.info('service.starting', { version: VERSION, ...config.redactedSummary() });

  const deps = { fetch: globalThis.fetch, logger };
  const jettyd = createJettydClient(config, deps);
  const posthog = createPostHogClient(config, deps);
  const runner = createBellRunner({ config, jettyd, posthog, logger });

  const handler = createRequestHandler({
    config,
    runner,
    logger,
    startedAt: Date.now(),
    version: VERSION,
  });
  const server = startHttpServer({
    handler,
    host: config.host,
    port: config.port,
    logger,
  });

  const scheduler = startReconcileScheduler({
    intervalMinutes: config.reconcileIntervalMinutes,
    runner,
    logger,
  });

  // Paint the panel once at boot so a restart does not leave a stale number up
  // until the first webhook or the first tick.
  if (scheduler.enabled) {
    runner
      .reconcile('startup')
      .catch((err) => logger.error('reconcile.error', { error: String(err?.message ?? err) }));
  }

  for (const signal of ['SIGTERM', 'SIGINT']) {
    process.on(signal, () => {
      logger.info('service.stopping', { signal });
      scheduler.stop();
      server.close(() => process.exit(0));
      // Do not wait forever on a hung keep-alive connection.
      setTimeout(() => process.exit(0), 5000).unref();
    });
  }

  process.on('unhandledRejection', (reason) => {
    logger.error('process.unhandled_rejection', { error: String(reason?.message ?? reason) });
  });
}

main();
