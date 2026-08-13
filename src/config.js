/**
 * Configuration is environment-only.
 *
 * Nothing is read from disk, nothing is baked into the image, and no default is
 * ever supplied for a credential — a missing secret is a startup failure, not a
 * silent fallback. `loadConfig` collects *every* problem before throwing so a
 * fresh deployment is fixed in one pass instead of five restarts.
 */

export class ConfigError extends Error {
  constructor(problems) {
    super(`invalid configuration:\n  - ${problems.join('\n  - ')}`);
    this.name = 'ConfigError';
    this.problems = problems;
  }
}

const DEFAULTS = {
  PORT: '3000',
  HOST: '0.0.0.0',
  POSTHOG_HOST: 'eu.posthog.com',
  POSTHOG_EVENT: 'device_claimed',
  RECONCILE_INTERVAL_MINUTES: '15',
  BELL_REST_ANGLE: '90',
  BELL_STRIKE_ANGLE: '45',
  BELL_HOLD_MS: '250',
  REQUEST_TIMEOUT_MS: '10000',
  LOG_LEVEL: 'info',
};

const REQUIRED = [
  'WEBHOOK_SECRET',
  'JETTYD_BASE_URL',
  'JETTYD_API_TOKEN',
  'JETTYD_DEVICE_ID',
  'POSTHOG_API_KEY',
  // Deliberately has no default. This repository is public, and a default here
  // would mean shipping the operator's real PostHog project ids in the source.
  'POSTHOG_PROJECT_IDS',
];

const MIN_SECRET_LENGTH = 16;
const SERVO_MIN_ANGLE = 0;
const SERVO_MAX_ANGLE = 180;

export function loadConfig(env = process.env) {
  const problems = [];
  const get = (key) => {
    const raw = env[key];
    return raw === undefined || raw === '' ? DEFAULTS[key] : raw;
  };

  for (const key of REQUIRED) {
    if (!env[key]) problems.push(`${key} is required but not set`);
  }

  const webhookSecret = env.WEBHOOK_SECRET ?? '';
  if (webhookSecret && webhookSecret.length < MIN_SECRET_LENGTH) {
    problems.push(`WEBHOOK_SECRET must be at least ${MIN_SECRET_LENGTH} characters`);
  }

  const baseUrl = (env.JETTYD_BASE_URL ?? '').replace(/\/+$/, '');
  if (baseUrl && !/^https?:\/\//.test(baseUrl)) {
    problems.push('JETTYD_BASE_URL must start with http:// or https://');
  }

  const port = readInt(get('PORT'), 'PORT', problems, { min: 1, max: 65535 });
  const reconcileIntervalMinutes = readInt(
    get('RECONCILE_INTERVAL_MINUTES'),
    'RECONCILE_INTERVAL_MINUTES',
    problems,
    { min: 0 },
  );
  const requestTimeoutMs = readInt(get('REQUEST_TIMEOUT_MS'), 'REQUEST_TIMEOUT_MS', problems, {
    min: 100,
  });

  const restAngle = readNumber(get('BELL_REST_ANGLE'), 'BELL_REST_ANGLE', problems, {
    min: SERVO_MIN_ANGLE,
    max: SERVO_MAX_ANGLE,
  });
  const strikeAngle = readNumber(get('BELL_STRIKE_ANGLE'), 'BELL_STRIKE_ANGLE', problems, {
    min: SERVO_MIN_ANGLE,
    max: SERVO_MAX_ANGLE,
  });
  const holdMs = readInt(get('BELL_HOLD_MS'), 'BELL_HOLD_MS', problems, { min: 0, max: 10000 });

  if (restAngle !== null && strikeAngle !== null && restAngle === strikeAngle) {
    problems.push(
      'BELL_STRIKE_ANGLE must differ from BELL_REST_ANGLE — an equal pair never moves the clapper',
    );
  }

  const rawProjectIds = env.POSTHOG_PROJECT_IDS ?? '';
  const projectIds = String(rawProjectIds)
    .split(',')
    .map((id) => id.trim())
    .filter(Boolean);
  // Only when something was supplied — an empty value already reported itself
  // as a missing required variable above, and one problem deserves one line.
  if (rawProjectIds !== '') {
    if (projectIds.length === 0) {
      problems.push('POSTHOG_PROJECT_IDS must list at least one project');
    }
    for (const id of projectIds) {
      if (!/^\d+$/.test(id)) problems.push(`POSTHOG_PROJECT_IDS contains a non-numeric id: ${id}`);
    }
  }

  const posthogEvent = String(get('POSTHOG_EVENT'));
  if (!/^[A-Za-z0-9_.$-]+$/.test(posthogEvent)) {
    problems.push('POSTHOG_EVENT may only contain letters, digits and _ . $ -');
  }

  const logLevel = String(get('LOG_LEVEL'));
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push('LOG_LEVEL must be one of debug, info, warn, error');
  }

  if (problems.length > 0) throw new ConfigError(problems);

  const config = {
    host: String(get('HOST')),
    port,
    logLevel,
    webhookSecret,
    reconcileIntervalMinutes,

    // One combined device: the servo and the panel are two drivers on the same
    // board, so there is exactly one device id and one command endpoint.
    jettyd: {
      baseUrl,
      token: env.JETTYD_API_TOKEN,
      deviceId: env.JETTYD_DEVICE_ID,
      timeoutMs: requestTimeoutMs,
    },

    // `restAngle` is a firmware-agreement guard, not a command parameter. Only
    // `strikeAngle` and `holdMs` go on the wire; the firmware owns the return
    // leg via the servo's own `home_angle`, and the equality check above is the
    // only thing `restAngle` actually does.
    bell: { restAngle, strikeAngle, holdMs },

    posthog: {
      host: String(get('POSTHOG_HOST')).replace(/^https?:\/\//, '').replace(/\/+$/, ''),
      apiKey: env.POSTHOG_API_KEY,
      projectIds,
      event: posthogEvent,
      timeoutMs: requestTimeoutMs,
    },
  };

  /** Everything that is safe to log or serve from /healthz. */
  config.redactedSummary = () => ({
    host: config.host,
    port: config.port,
    log_level: config.logLevel,
    reconcile_interval_minutes: config.reconcileIntervalMinutes,
    jettyd_base_url: config.jettyd.baseUrl,
    device_id: config.jettyd.deviceId,
    bell: { ...config.bell },
    posthog_host: config.posthog.host,
    posthog_projects: [...config.posthog.projectIds],
    posthog_event: config.posthog.event,
    request_timeout_ms: config.jettyd.timeoutMs,
  });

  return config;
}

function readInt(raw, key, problems, { min = -Infinity, max = Infinity } = {}) {
  if (!/^-?\d+$/.test(String(raw).trim())) {
    problems.push(`${key} must be an integer (got "${raw}")`);
    return null;
  }
  const value = Number.parseInt(String(raw), 10);
  if (value < min || value > max) {
    problems.push(`${key} must be between ${min} and ${max} (got ${value})`);
    return null;
  }
  return value;
}

function readNumber(raw, key, problems, { min = -Infinity, max = Infinity } = {}) {
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    problems.push(`${key} must be a number (got "${raw}")`);
    return null;
  }
  if (value < min || value > max) {
    problems.push(`${key} must be between ${min} and ${max} (got ${value})`);
    return null;
  }
  return value;
}
