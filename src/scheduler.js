/**
 * Periodic reconciliation.
 *
 * Webhooks are the fast path and reconciliation is the correctness path. If a
 * webhook is lost, the destination is paused, or the service was restarted
 * mid-month, the panel is wrong until the next claim. This timer re-asks
 * PostHog every RECONCILE_INTERVAL_MINUTES (default 15) and repaints the
 * display — without ringing the bell, because no new claim happened.
 */

export function startReconcileScheduler({
  intervalMinutes,
  runner,
  logger,
  timers = { setInterval, clearInterval },
}) {
  if (!Number.isFinite(intervalMinutes) || intervalMinutes <= 0) {
    logger.info('reconcile.disabled', {
      why: 'RECONCILE_INTERVAL_MINUTES is 0 — the display only updates on webhooks',
    });
    return { enabled: false, intervalMs: 0, stop() {} };
  }

  const intervalMs = intervalMinutes * 60 * 1000;

  const handle = timers.setInterval(async () => {
    try {
      await runner.reconcile('scheduler');
    } catch (err) {
      // Never let a bad tick kill the interval — the next one may well work.
      logger.error('reconcile.error', { error: String(err?.message ?? err) });
    }
  }, intervalMs);

  // Do not hold the process open on this timer alone.
  if (typeof handle?.unref === 'function') handle.unref();

  logger.info('reconcile.scheduled', { interval_minutes: intervalMinutes, interval_ms: intervalMs });

  return {
    enabled: true,
    intervalMs,
    stop() {
      timers.clearInterval(handle);
    },
  };
}
