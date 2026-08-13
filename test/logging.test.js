import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { createLogger } from '../src/logger.js';
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

describe('logger', () => {
  it('emits one JSON object per line', () => {
    const lines = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });

    logger.info('thing.happened', { count: 3 });

    assert.equal(lines.length, 1);
    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'thing.happened');
    assert.equal(record.level, 'info');
    assert.equal(record.count, 3);
    assert.ok(Date.parse(record.ts));
  });

  it('honours the level threshold', () => {
    const lines = [];
    const logger = createLogger({ level: 'warn', sink: (line) => lines.push(line) });

    logger.debug('a');
    logger.info('b');
    logger.warn('c');
    logger.error('d');

    assert.deepEqual(
      lines.map((l) => JSON.parse(l).event),
      ['c', 'd'],
    );
  });

  it('stamps child bindings onto every line', () => {
    const lines = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });

    logger.child({ run_id: 'run-9' }).info('run.started', { kind: 'bell' });

    const record = JSON.parse(lines[0]);
    assert.equal(record.run_id, 'run-9');
    assert.equal(record.event, 'run.started');
  });
});

describe('run logs are useful enough to debug from', () => {
  function buildRunner(fetchImpl) {
    const config = testConfig();
    const { logger, records } = captureLogger();
    const deps = { fetch: fetchImpl, logger };
    const runner = createBellRunner({
      config,
      jettyd: createJettydClient(config, deps),
      posthog: createPostHogClient(config, deps),
      logger,
    });
    return { runner, records, config, logger };
  }

  it('records the whole chain, correlated by run_id', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 131280: 30, 214227: 9, 218818: 3 }));
    const { runner, records } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    // What an operator running at the default level actually sees.
    const events = records.filter((r) => r.level !== 'debug').map((r) => r.event);
    assert.deepEqual(events, [
      'run.started',
      'bell.rang',
      'query.completed',
      'display.updated',
      'run.finished',
    ]);

    const runIds = new Set(records.filter((r) => r.run_id).map((r) => r.run_id));
    assert.equal(runIds.size, 1, 'every line of one run shares a run_id');
  });

  it('logs the per-project breakdown, which is what a wrong total is diagnosed from', async () => {
    const fetchImpl = mockFetch(posthogCounts({ 131280: 30, 214227: 9, 218818: 3 }));
    const { runner, records } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    const [completed] = records.filter((r) => r.event === 'query.completed');
    assert.deepEqual(completed.per_project, { 131280: 30, 214227: 9, 218818: 3 });
    assert.equal(completed.count, 42);
  });

  it('names the failing project and says what it cost', async () => {
    const fetchImpl = mockFetch({ 'posthog:214227': jsonResponse(503, {}) });
    const { runner, records } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    const [failed] = records.filter((r) => r.event === 'query.failed');
    assert.deepEqual(failed.failed_projects, ['214227']);
    assert.match(failed.consequence, /display left unchanged/);

    const [project] = records.filter((r) => r.event === 'posthog.project_failed');
    assert.equal(project.project_id, '214227');
    assert.match(project.error, /503/);
  });

  it('does not let a payload field overwrite the log event name', async () => {
    // The PostHog body carries its own `event` key; a naive spread would
    // rewrite 'webhook.accepted' into 'device_claimed' and make the line
    // impossible to filter on.
    const config = testConfig();
    const { logger, records } = captureLogger();
    const fetchImpl = mockFetch(posthogCounts({ 131280: 1, 214227: 0, 218818: 0 }));
    const deps = { fetch: fetchImpl, logger };
    const runner = createBellRunner({
      config,
      jettyd: createJettydClient(config, deps),
      posthog: createPostHogClient(config, deps),
      logger,
    });
    const handler = createRequestHandler({ config, runner, logger, startedAt: Date.now() });

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

    const accepted = records.filter((r) => r.event === 'webhook.accepted');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].event_name, 'device_claimed');
  });
});
