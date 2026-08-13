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

  it('will not let a caller field overwrite a reserved key', () => {
    // Consumers filter on `event` and `level`. A field that captured either one
    // would make the line unfindable by exactly the query used to find it.
    const lines = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });

    logger.warn('webhook.accepted', { event: 'device_claimed', level: 'debug', ts: 'nonsense' });

    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'webhook.accepted');
    assert.equal(record.level, 'warn');
    assert.ok(Date.parse(record.ts), 'ts must still be a real timestamp');
  });

  it('will not let a child binding overwrite a reserved key either', () => {
    const lines = [];
    const logger = createLogger({ level: 'debug', sink: (line) => lines.push(line) });

    logger.child({ event: 'bound', level: 'error' }).info('run.started');

    const record = JSON.parse(lines[0]);
    assert.equal(record.event, 'run.started');
    assert.equal(record.level, 'info');
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
    const fetchImpl = mockFetch(posthogCounts({ 100001: 30, 100002: 9, 100003: 3 }));
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
    const fetchImpl = mockFetch(posthogCounts({ 100001: 30, 100002: 9, 100003: 3 }));
    const { runner, records } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    const [completed] = records.filter((r) => r.event === 'query.completed');
    assert.deepEqual(completed.per_project, { 100001: 30, 100002: 9, 100003: 3 });
    assert.equal(completed.count, 42);
  });

  it('names the failing project and says what it cost', async () => {
    const fetchImpl = mockFetch({ 'posthog:100002': jsonResponse(503, {}) });
    const { runner, records } = buildRunner(fetchImpl);

    await runner.trigger('webhook');

    const [failed] = records.filter((r) => r.event === 'query.failed');
    assert.deepEqual(failed.failed_projects, ['100002']);
    assert.match(failed.consequence, /display left unchanged/);

    const [project] = records.filter((r) => r.event === 'posthog.project_failed');
    assert.equal(project.project_id, '100002');
    assert.match(project.error, /503/);
  });

  it('does not let a payload field overwrite the log event name', async () => {
    // The PostHog body carries its own `event` key; a naive spread would
    // rewrite 'webhook.accepted' into 'device_claimed' and make the line
    // impossible to filter on.
    const config = testConfig();
    const { logger, records } = captureLogger();
    const fetchImpl = mockFetch(posthogCounts({ 100001: 1, 100002: 0, 100003: 0 }));
    const deps = { fetch: fetchImpl, logger };
    const runner = createBellRunner({
      config,
      jettyd: createJettydClient(config, deps),
      posthog: createPostHogClient(config, deps),
      logger,
    });
    // The handler answers 202 and runs afterwards; hold the run so the test
    // does not leave work in flight behind it.
    let run;
    const handler = createRequestHandler({
      config,
      runner: { ...runner, trigger: (reason) => (run = runner.trigger(reason)) },
      logger,
      startedAt: Date.now(),
    });

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
    await run;

    const accepted = records.filter((r) => r.event === 'webhook.accepted');
    assert.equal(accepted.length, 1);
    assert.equal(accepted[0].event_name, 'device_claimed');
  });
});
