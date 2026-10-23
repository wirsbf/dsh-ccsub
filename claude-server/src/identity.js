/**
 * Claude Code request identity.
 *
 * This is the same reconstruction the local plugin performs in
 * `lib/egress.js`, repeated here on purpose: the two sides are independent
 * processes that may be updated separately, so neither may assume the other
 * already rewrote the headers. The function is idempotent — it builds a fresh
 * `Headers` and refills it in the official client's order rather than editing
 * whatever arrived — so running it twice produces the same set as running it
 * once.
 *
 * Why it must run at all: `PiAiAdapter` merges `attributionHeaders()` into every
 * request last, which overwrites the User-Agent with the harness identity. The
 * subscription identity therefore has to be re-asserted below that merge, which
 * is what this module is for.
 *
 * @module claude-server/identity
 */

import os from 'node:os';

/** The SDK version the official client reports through x-stainless-package-version. */
const STAINLESS_SDK_VERSION = '0.70.0';

/** Header names the official client emits first, in this order. */
const LEADING_HEADERS = ['authorization', 'content-type', 'accept', 'anthropic-version', 'anthropic-beta'];

/**
 * The two OAuth betas every Claude Code request carries.
 *
 * Without them the request leaves the Claude Code rate bucket, which surfaces
 * as a rate-limit rejection rather than an auth error.
 */
export const BASE_BETAS = 'claude-code-20250219,oauth-2025-04-20';

/**
 * The extra betas a request needs once it asks for adaptive thinking.
 *
 * Anthropic gates these shapes behind their flags: `output_config.effort` and
 * `thinking.block_binding` are rejected unless the matching beta is declared.
 * The forwarding proxy this server replaced always sent all three whenever a
 * body carried `thinking` or `output_config`; keeping that rule here means a
 * thinking request keeps working instead of degrading.
 */
export const THINKING_BETAS =
  'mid-conversation-output-config-2026-07-01,thinking-binding-controls-2026-08-01,mid-conversation-tool-changes-2026-07-01';

/**
 * Whether a parsed request body asks for thinking or an effort level.
 * @param body - the parsed JSON body, or undefined when there is none.
 * @returns true when the thinking betas must be declared.
 */
export function wantsThinkingBetas(body) {
  if (body === null || typeof body !== 'object') return false;
  return body.thinking !== undefined || body.output_config !== undefined;
}

/** Map process.platform onto the SDK's spelling of x-stainless-os. */
function stainlessOs() {
  if (process.platform === 'darwin') return 'MacOS';
  if (process.platform === 'win32') return 'Windows';
  return 'Linux';
}

/** Map os.arch() onto the SDK's spelling of x-stainless-arch. */
function stainlessArch() {
  const arch = os.arch();
  if (arch === 'x64') return 'x64';
  if (arch === 'arm64') return 'arm64';
  return arch;
}

/**
 * Rebuild the request headers as the official Claude Code client emits them.
 *
 * Every value that describes the runtime is a constant or a fixed asset here
 * rather than a read of this process, so the identity does not drift when the
 * container's Node version differs from the machine that produced the request.
 * `x-stainless-runtime-version` in particular is pinned: leaving it to
 * `process.version` would make the claimed runtime change with the image and
 * contradict the `claude-cli/…` User-Agent beside it.
 *
 * @param headers - whatever the caller prepared (any HeadersInit).
 * @param cliVersion - the claude-cli version to claim.
 * @param runtimeVersion - the pinned runtime version string for x-stainless.
 * @returns a new Headers carrying the subscription identity.
 */
export function withClaudeIdentity(headers, cliVersion, runtimeVersion = 'v22.19.0') {
  const version =
    typeof cliVersion === 'string' && cliVersion.length > 0 ? cliVersion : '2.1.283';
  const source = new Headers();
  if (headers !== undefined && headers !== null) {
    const entries =
      headers instanceof Headers
        ? [...headers.entries()]
        : Array.isArray(headers)
          ? headers
          : Object.entries(headers);
    for (const [name, value] of entries) {
      if (value === undefined || value === null) continue;
      source.set(String(name), String(value));
    }
  }
  const out = new Headers();
  // The official client emits these first, in this order.
  for (const name of LEADING_HEADERS) {
    const value = source.get(name);
    if (value !== null) out.set(name, value);
  }
  out.set('user-agent', `claude-cli/${version} (external, cli)`);
  out.set('x-app', 'cli');
  // x-stainless-* telemetry, as the official TypeScript SDK sends it.
  out.set('x-stainless-lang', 'js');
  out.set('x-stainless-package-version', STAINLESS_SDK_VERSION);
  out.set('x-stainless-os', stainlessOs());
  out.set('x-stainless-arch', stainlessArch());
  out.set('x-stainless-runtime', 'node');
  out.set('x-stainless-runtime-version', runtimeVersion);
  out.set('x-stainless-retry-count', '0');
  out.set('x-stainless-timeout', '600');
  // Anything the caller carried that we did not place yet keeps its relative
  // order after ours.
  for (const [name, value] of source.entries()) {
    if (!out.has(name)) out.set(name, value);
  }
  return out;
}

/**
 * Ensure the beta header carries at least the two OAuth betas.
 *
 * Existing values are preserved: a caller that asked for extra betas keeps
 * them. Only the base pair is added when missing, and the result is
 * de-duplicated while preserving first-seen order.
 * @param headers - the built header set; mutated in place.
 * @returns the same headers.
 */
export function ensureBaseBetas(headers, extra = '') {
  const current = headers.get('anthropic-beta') ?? '';
  const seen = new Set();
  const parts = [];
  for (const raw of [...current.split(','), ...BASE_BETAS.split(','), ...String(extra).split(',')]) {
    const token = raw.trim();
    if (token.length === 0 || seen.has(token)) continue;
    seen.add(token);
    parts.push(token);
  }
  headers.set('anthropic-beta', parts.join(','));
  return headers;
}
