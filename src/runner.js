/**
 * The run loop: strike → query → display, one run at a time.
 *
 * Ordering is the contract:
 *
 *   1. `servo.rotate` — ring the bell, and *await the attempt*. The bell is the
 *      reaction to the event; it fires before anything slower can delay it.
 *   2. PostHog — ask every project for the authoritative current-month count.
 *      A failure here stops the run: the panel keeps its last good number
 *      rather than showing a partial sum.
 *   3. `display.set` — write that number to the same device.
 *
 * A failed strike does *not* stop the run. A silent bell with a correct number
 * is a much better failure than a ringing bell with a stale number.
 *
 * Concurrency: exactly one run at a time. Anything arriving mid-run is
 * coalesced into a single follow-up run, so a burst of five webhooks produces
 * two strikes rather than five overlapping ones fighting over one servo.
 */

export function createBellRunner({ config, jettyd, posthog, logger, clock = () => new Date() }) {
  let busy = false;
  /** At most one queued bell run; extra triggers raise its request count. */
  let pendingBell = null;
  /** At most one queued reconcile; further ones are skipped, not stacked. */
  let pendingReconcile = null;
  let lastRun = null;
  let runSeq = 0;

  function deferred() {
    let resolve;
    const promise = new Promise((res) => {
      resolve = res;
    });
    return { promise, resolve };
  }

  function trigger(reason = 'webhook') {
    if (busy) {
      if (!pendingBell) {
        const gate = deferred();
        pendingBell = { kind: 'bell', reason, requests: 0, resolve: gate.resolve, promise: gate.promise };
      }
      pendingBell.requests += 1;
      logger.info('run.coalesced', {
        trigger: reason,
        queued_requests: pendingBell.requests,
      });
      return pendingBell.promise;
    }
    return start({ kind: 'bell', reason, requests: 1 });
  }

  function reconcile(reason = 'scheduler') {
    if (busy) {
      if (pendingReconcile) {
        logger.info('reconcile.skipped', {
          trigger: reason,
          why: 'a reconcile is already queued behind the running job',
        });
        return Promise.resolve({ skipped: true, ok: true, reason });
      }
      const gate = deferred();
      pendingReconcile = {
        kind: 'reconcile',
        reason,
        requests: 1,
        resolve: gate.resolve,
        promise: gate.promise,
      };
      return pendingReconcile.promise;
    }
    return start({ kind: 'reconcile', reason, requests: 1 });
  }

  function start(job) {
    const gate = deferred();
    busy = true;
    void drain({ ...job, resolve: gate.resolve });
    return gate.promise;
  }

  /** Run jobs back to back until the queue empties, then release `busy`. */
  async function drain(firstJob) {
    let job = firstJob;
    try {
      while (job) {
        let result;
        try {
          result = await runOnce(job);
        } catch (err) {
          // runOnce is written to be total; this is the last line of defence so
          // a caller can never be left with an unresolved promise.
          logger.error('run.unexpected_error', { error: String(err?.message ?? err) });
          result = {
            runId: null,
            ok: false,
            trigger: job.reason,
            kind: job.kind,
            coalesced: job.requests,
            bell: { attempted: job.kind === 'bell', ok: null, error: null },
            count: null,
            displayed: false,
            error: { stage: 'internal', message: String(err?.message ?? err) },
          };
        }
        job.resolve(result);
        job = nextJob();
      }
    } finally {
      busy = false;
    }
  }

  function nextJob() {
    if (pendingBell) {
      const job = pendingBell;
      pendingBell = null;
      return job;
    }
    if (pendingReconcile) {
      const job = pendingReconcile;
      pendingReconcile = null;
      return job;
    }
    return null;
  }

  async function runOnce(job) {
    const runId = `run-${++runSeq}`;
    const log = logger.child({ run_id: runId });
    const startedAt = clock();

    log.info('run.started', {
      kind: job.kind,
      trigger: job.reason,
      requests: job.requests,
    });

    // ── 1. strike ────────────────────────────────────────────────────────────
    const bell = { attempted: job.kind === 'bell', ok: null, error: null };
    if (bell.attempted) {
      try {
        await jettyd.ringBell();
        bell.ok = true;
        log.info('bell.rang', {
          angle: config.bell.strikeAngle,
          rest_angle: config.bell.restAngle,
          hold_ms: config.bell.holdMs,
        });
      } catch (err) {
        bell.ok = false;
        bell.error = String(err?.message ?? err);
        // Deliberately not fatal — the count still matters.
        log.warn('bell.failed', { error: bell.error });
      }
    }

    // ── 2. authoritative count ───────────────────────────────────────────────
    let count;
    let perProject;
    try {
      const totals = await posthog.fetchMonthlyTotal();
      count = totals.total;
      perProject = totals.perProject;
      log.info('query.completed', { count, per_project: perProject });
    } catch (err) {
      log.error('query.failed', {
        error: String(err?.message ?? err),
        failed_projects: err?.failures?.map((f) => f.projectId) ?? null,
        consequence: 'display left unchanged — a partial sum is worse than a stale one',
      });
      return finish(job, {
        runId,
        startedAt,
        bell,
        count: null,
        perProject: null,
        displayed: false,
        ok: false,
        error: { stage: 'query', message: String(err?.message ?? err) },
      });
    }

    // ── 3. display ───────────────────────────────────────────────────────────
    try {
      await jettyd.setDisplay(count);
      log.info('display.updated', { count });
      return finish(job, {
        runId,
        startedAt,
        bell,
        count,
        perProject,
        displayed: true,
        ok: true,
        error: null,
      });
    } catch (err) {
      log.error('display.failed', { error: String(err?.message ?? err), count });
      return finish(job, {
        runId,
        startedAt,
        bell,
        count,
        perProject,
        displayed: false,
        ok: false,
        error: { stage: 'display', message: String(err?.message ?? err) },
      });
    }
  }

  function finish(job, outcome) {
    const result = {
      runId: outcome.runId,
      kind: job.kind,
      trigger: job.reason,
      coalesced: job.requests,
      ok: outcome.ok,
      bell: outcome.bell,
      count: outcome.count,
      perProject: outcome.perProject,
      displayed: outcome.displayed,
      error: outcome.error,
      at: outcome.startedAt.toISOString(),
      durationMs: clock().getTime() - outcome.startedAt.getTime(),
    };

    lastRun = result;
    logger.info('run.finished', {
      run_id: result.runId,
      kind: result.kind,
      ok: result.ok,
      bell_ok: result.bell.ok,
      count: result.count,
      displayed: result.displayed,
      duration_ms: result.durationMs,
    });
    return result;
  }

  return {
    trigger,
    reconcile,
    stats: () => ({ busy, lastRun }),
  };
}
