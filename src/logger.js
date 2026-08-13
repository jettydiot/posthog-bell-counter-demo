/**
 * One-line-per-event JSON logging.
 *
 * Every line is a complete JSON object so `docker logs | jq` works, and the
 * sink is injectable so tests can assert on structure rather than on strings.
 * Secrets are never passed in here — see config.redactedSummary().
 */

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

export function createLogger({
  level = 'info',
  sink = (line) => process.stdout.write(`${line}\n`),
  now = () => new Date(),
  bindings = {},
} = {}) {
  const threshold = LEVELS[level] ?? LEVELS.info;

  function emit(levelName, event, fields = {}) {
    if (LEVELS[levelName] < threshold) return;
    // The reserved keys go *after* the spreads. Consumers filter on `event` and
    // `level`, so a caller field of the same name — a PostHog payload carries
    // its own `event`, for one — would otherwise make the line unfindable.
    sink(
      JSON.stringify({
        ...bindings,
        ...fields,
        ts: now().toISOString(),
        level: levelName,
        event,
      }),
    );
  }

  return {
    level,
    debug: (event, fields) => emit('debug', event, fields),
    info: (event, fields) => emit('info', event, fields),
    warn: (event, fields) => emit('warn', event, fields),
    error: (event, fields) => emit('error', event, fields),
    /** Derive a logger that stamps every line with extra fields (e.g. run_id). */
    child: (extra) => createLogger({ level, sink, now, bindings: { ...bindings, ...extra } }),
  };
}

export const LOG_LEVELS = Object.keys(LEVELS);
