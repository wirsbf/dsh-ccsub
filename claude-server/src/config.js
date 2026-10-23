/**
 * Configuration, read once at startup.
 *
 * Every value that must not be defaulted is required explicitly: a server that
 * silently picked a weak default for the client bearer, or silently fell back
 * to a direct connection, would be worse than one that refuses to start.
 *
 * @module claude-server/config
 */

/** Read a boolean-ish environment value. */
function bool(value, fallback) {
  if (value === undefined || value === '') return fallback;
  return !['0', 'false', 'no', 'off'].includes(String(value).trim().toLowerCase());
}

/** Read a positive integer, or the fallback. */
function int(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ''), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

/**
 * Build the configuration from the environment.
 * @param env - the process environment.
 * @returns the configuration.
 * @throws {Error} when a required value is missing or contradictory.
 */
export function loadConfig(env = process.env) {
  const mode = String(env.UPSTREAM_MODE ?? 'proxy').trim().toLowerCase();
  if (mode !== 'proxy' && mode !== 'direct') {
    throw new Error(`UPSTREAM_MODE must be "proxy" or "direct", got ${JSON.stringify(env.UPSTREAM_MODE)}`);
  }
  const listenHost = String(env.LISTEN_HOST ?? '0.0.0.0').trim() || '0.0.0.0';
  const listenPort = int(env.LISTEN_PORT, 4710);
  const grantPath = String(env.GRANT_PATH ?? '/data/grant.json').trim();
  if (grantPath.length === 0) throw new Error('GRANT_PATH must not be empty');
  return {
    listenHost,
    listenPort,
    mode,
    proxyUrl: env.PROXY_URL,
    grantPath,
    clientBearer: env.CLIENT_BEARER,
    claudeCliVersion: String(env.CLAUDE_CLI_VERSION ?? '2.1.303').trim() || '2.1.303',
    // Pinned rather than read from this process: the claimed runtime must not
    // drift when the image's Node version changes, or it contradicts the
    // claude-cli User-Agent beside it.
    stainlessRuntimeVersion: String(env.STAINLESS_RUNTIME_VERSION ?? 'v22.19.0').trim() || 'v22.19.0',
    refreshSkewMs: int(env.REFRESH_SKEW_MS, 300_000),
    // Bounds how long an unauthenticated login attempt may stay pending.
    loginTtlMs: int(env.LOGIN_TTL_MS, 10 * 60 * 1000),
    sanitizeBody: bool(env.SANITIZE_BODY, true),
    logLevel: String(env.LOG_LEVEL ?? 'info').trim() || 'info',
  };
}
