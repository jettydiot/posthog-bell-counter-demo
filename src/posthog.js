/**
 * The authoritative counter.
 *
 * PostHog — not this process — owns the number. Every run asks all configured
 * projects for the current calendar month's `device_claimed` count and sums the
 * answers. Nothing is cached and nothing is incremented locally, so a restart,
 * a missed webhook or a replayed webhook cannot drift the panel.
 *
 * All-or-nothing: if any project fails to answer, the caller gets an error
 * rather than a smaller number. A partial sum looks exactly like a real one on
 * a four-digit LED panel, which is the worst kind of wrong.
 */

import { postJson, readJson } from './http.js';
import { redact } from './secret.js';

export class PostHogQueryError extends Error {
  constructor(failures) {
    const detail = failures.map((f) => `${f.projectId} (${f.reason})`).join(', ');
    super(`PostHog query failed for project(s): ${detail}`);
    this.name = 'PostHogQueryError';
    this.failures = failures;
  }
}

export function createPostHogClient(config, { fetch: fetchImpl, logger }) {
  const { host, apiKey, projectIds, event, timeoutMs } = config.posthog;

  /**
   * Calendar-month window, evaluated by PostHog rather than by this process, so
   * the boundary is consistent across restarts and time zones.
   */
  const query =
    `SELECT count() FROM events ` +
    `WHERE event = '${event}' ` +
    `AND timestamp >= toStartOfMonth(now('UTC')) ` +
    `AND timestamp < toStartOfMonth(now('UTC')) + toIntervalMonth(1)`;

  async function queryProject(projectId) {
    const url = `https://${host}/api/projects/${projectId}/query/`;
    const response = await postJson(fetchImpl, url, {
      headers: { Authorization: `Bearer ${apiKey}` },
      body: { query: { kind: 'HogQLQuery', query } },
      timeoutMs,
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}`);
    }

    const data = await readJson(response);
    const raw = data?.results?.[0]?.[0];
    const count = typeof raw === 'number' ? raw : Number.NaN;
    if (!Number.isInteger(count) || count < 0) {
      throw new Error(`unexpected result shape (${JSON.stringify(raw)})`);
    }
    return count;
  }

  /**
   * Projects are queried in order rather than in parallel: there are only a
   * handful, the ordering makes the log readable, and every project is asked
   * even after one has failed so the error can name all of the broken ones.
   */
  async function fetchMonthlyTotal() {
    const perProject = {};
    const failures = [];

    for (const projectId of projectIds) {
      try {
        perProject[projectId] = await queryProject(projectId);
        logger.debug('posthog.project_queried', {
          project_id: projectId,
          count: perProject[projectId],
        });
      } catch (err) {
        const reason = redact(err?.message ?? String(err), apiKey);
        failures.push({ projectId, reason });
        logger.warn('posthog.project_failed', { project_id: projectId, error: reason });
      }
    }

    if (failures.length > 0) {
      throw new PostHogQueryError(failures);
    }

    const total = Object.values(perProject).reduce((sum, n) => sum + n, 0);
    return { total, perProject };
  }

  return { fetchMonthlyTotal, query };
}
