/**
 * Sign-in, refresh, and quota for the `claude-sub` route.
 *
 * @module dsh-ccsub/auth/claude
 */

import { createModels, createProvider } from '@earendil-works/pi-ai';
import { anthropicProvider } from '@earendil-works/pi-ai/providers/anthropic';
import { anthropicMessagesApi } from '@earendil-works/pi-ai/api/anthropic-messages.lazy';
import { LlmError } from '@deepseek-ai/dsh-llm';
import { PROVIDER_ID, credentialStoreFrom, authContextFrom, recordKeyFor } from './store.js';

/** The OAuth usage endpoint — the source of Claude Code's `/usage` screen. */
export const CLAUDE_USAGE_URL = 'https://api.anthropic.com/api/oauth/usage';

/** The models listing endpoint — what the official CLI reads its model menu from. */
export const CLAUDE_MODELS_URL = 'https://api.anthropic.com/v1/models';

/** Conservative descriptor defaults for models the static catalog does not know. */
const DYNAMIC_MODEL_CONTEXT_WINDOW = 200_000;
const DYNAMIC_MODEL_MAX_TOKENS = 64_000;

/** Five minutes: refresh this long before expiry rather than after. */
const DEFAULT_REFRESH_SKEW_MS = 300_000;

/**
 * Bound on a token refresh.
 *
 * pi-ai's refresh combines the caller's signal with its own 30 s timeout via
 * `AbortSignal.any([signal, ...])`, which **throws** on a non-signal. The
 * adapter's `resolveApiKey(provider, profile)` hook has no signal to pass, so a
 * substitution is mandatory here rather than decorative.
 */
const REFRESH_TIMEOUT_MS = 30_000;

/** The OAuth token endpoint pi-ai exchanges and refreshes against. */
const TOKEN_ENDPOINT_HOST = 'platform.claude.com';
const TOKEN_ENDPOINT_PATH = '/v1/oauth/token';
void TOKEN_ENDPOINT_HOST; void TOKEN_ENDPOINT_PATH;

/**
 * Route pi-ai's OAuth traffic through the egress guard.
 *
 * pi-ai's `postJson` calls the **bare global `fetch`**, so the token exchange
 * and the refresh would otherwise escape this plugin's transport. Two hardening
 * choices replace the original narrow host+path match, because that match would
 * silently stop guarding the moment pi-ai moved or added an endpoint:
 *
 * 1. **Every Anthropic-owned host is routed**, not one exact URL: a new token
 *    path, or an auth-related call to another Anthropic domain, is guarded by
 *    default rather than leaking around the patch.
 * 2. **The patch heals itself.** Another plugin (or an undici upgrade) can wrap
 *    the global after us, hiding our patch. `ensureFetchGuarded()` re-checks
 *    and re-installs on demand, and the refresh path calls it before every
 *    refresh, so the guarantee is re-asserted exactly when it matters.
 *
 * Non-Anthropic requests — including every other plugin's — pass through
 * untouched.
 *
 * @param guard - the egress guard supplying the guarded transport.
 * @returns a disposer that restores the original global.
 */
export const ANTHROPIC_HOSTS = new Set([
  'api.anthropic.com',
  'platform.claude.com',
  'claude.ai',
  'console.anthropic.com',
]);

let patchToken = null;

export function guardTokenEndpoint(guard) {
  const original = globalThis.fetch;
  const token = Symbol('dsh-ccsub/fetch-guard');
  patchToken = token;
  const patched = (input, init) => {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
    } catch {
      return original(input, init);
    }
    return ANTHROPIC_HOSTS.has(url.hostname) ? guard.fetch(input, init) : original(input, init);
  };
  patched[token] = true;
  globalThis.fetch = patched;
  return () => {
    // Only unpatch our own function: another plugin may have patched after us.
    if (globalThis.fetch === patched) globalThis.fetch = original;
  };
}

/**
 * Re-assert the global fetch guard if something wrapped over it.
 *
 * Cheap (a property check) and safe to call often; `resolveAccessToken` calls
 * it before every refresh. When the current global is already our patch this is
 * a no-op; when it is not, the current global is wrapped so Anthropic-bound
 * calls are guarded again without disturbing other traffic.
 * @param guard - the egress guard supplying the guarded transport.
 */
export function ensureFetchGuarded(guard) {
  if (patchToken === null) return;
  const current = globalThis.fetch;
  if (typeof current === 'function' && current[patchToken] === true) return;
  const original = current;
  const patched = (input, init) => {
    let url;
    try {
      url = new URL(typeof input === 'string' ? input : (input?.url ?? String(input)));
    } catch {
      return original(input, init);
    }
    return ANTHROPIC_HOSTS.has(url.hostname) ? guard.fetch(input, init) : original(input, init);
  };
  patched[patchToken] = true;
  globalThis.fetch = patched;
}

/**
 * The Anthropic provider, re-keyed to this route.
 *
 * The identity that matters here is `id`: pi-ai's `Models.login()`, `getAuth`,
 * and the credential store are all keyed by `Provider.id`, so a sign-in must
 * run against a provider whose id is this route's — otherwise the grant lands
 * in a record the authorization seam is not watching.
 *
 * The auth definitions, base URL, and model catalog are pi-ai's real Anthropic
 * ones, so the official OAuth flow is what runs. The transport is always
 * wrapped: with a guard it routes through the guard, and without one it uses
 * pi-ai's own `api` object (which `createProvider` consumes rather than
 * exposes, so it is reconstructed from the same module factory).
 * @param guard - the egress guard, or undefined for auth-only use.
 * @param options - optional catalog overrides (`contextWindowOverride`).
 * @returns the provider for a pi-ai `Models` collection.
 */
export function subscriptionProvider(guard, options = {}) {
  const base = anthropicProvider();
  const inner = anthropicMessagesApi();
  const overrideWindow =
    typeof options.contextWindowOverride === 'number' && options.contextWindowOverride > 0
      ? options.contextWindowOverride
      : undefined;
  const transport = {
    stream: (model, context, options) =>
      guard === undefined
        ? inner.stream(model, context, options)
        : inner.stream(model, context, { ...options, fetch: guard.fetch }),
    streamSimple: (model, context, options) =>
      guard === undefined
        ? inner.streamSimple(model, context, options)
        : inner.streamSimple(model, context, { ...options, fetch: guard.fetch }),
  };
  return createProvider({
    id: PROVIDER_ID,
    name: 'Claude Subscription',
    baseUrl: base.baseUrl,
    headers: base.headers,
    auth: base.auth,
    models: base.getModels().map((model) => ({
      ...model,
      provider: PROVIDER_ID,
      ...(overrideWindow !== undefined ? { contextWindow: overrideWindow } : {}),
    })),
    // Dynamic overlay: read the live model list from the official endpoint,
    // exactly as the official CLI does, through the egress guard. Only ids the
    // static catalog lacks become overlay entries — a same-id overlay would
    // replace the catalog's rich metadata with our sparse descriptor.
    ...(guard === undefined
      ? {}
      : {
          fetchModels: async (context) => {
            if (!context.allowNetwork || context.credential === undefined) return [];
            const credential = context.credential;
            const access =
              credential.type === 'oauth'
                ? credential.access
                : credential.type === 'apiKey'
                  ? credential.key
                  : undefined;
            if (typeof access !== 'string' || access.length === 0) return [];
            const response = await guard.fetch(`${CLAUDE_MODELS_URL}?limit=1000`, {
              headers: {
                authorization: `Bearer ${access}`,
                'anthropic-version': '2023-06-01',
                'anthropic-beta': 'oauth-2025-04-20',
                accept: 'application/json',
              },
              signal: context.signal,
            });
            if (!response.ok) {
              throw new Error(`the models endpoint answered ${response.status}`);
            }
            const payload = await response.json();
            const known = new Set(base.getModels().map((model) => model.id));
            const entries = Array.isArray(payload?.data) ? payload.data : [];
            return entries
              .filter((entry) => typeof entry?.id === 'string' && !known.has(entry.id))
              .map((entry) => ({
                id: entry.id,
                name:
                  typeof entry.display_name === 'string' && entry.display_name.length > 0
                    ? entry.display_name
                    : entry.id,
                api: 'anthropic-messages',
                provider: PROVIDER_ID,
                baseUrl: base.baseUrl,
                reasoning: false,
                input: ['text', 'image'],
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
                contextWindow: DYNAMIC_MODEL_CONTEXT_WINDOW,
                maxTokens: DYNAMIC_MODEL_MAX_TOKENS,
              }));
          },
        }),
    api: transport,
  });
}

/**
 * A `Models` collection wired to this plugin's credential plane.
 *
 * Because the credential store is backed by `ctx.get('credentials')`, every write —
 * including the read-modify-write that wraps a refresh — is serialized across
 * processes. Passing a shared provider makes the collection's model refresh
 * (dynamic catalog overlay) land on the same provider instance the adapter
 * reads, so a refresh is visible to the route without re-registration.
 * @param ctx - the plugin context.
 * @param guard - the egress guard, or undefined for auth-only use.
 * @param provider - the shared provider instance, when one exists.
 * @returns the collection to drive sign-in and auth checks through.
 */
export function modelsFor(ctx, guard, provider) {
  const models = createModels({
    credentials: credentialStoreFrom(ctx),
    authContext: authContextFrom(ctx),
  });
  models.setProvider(provider ?? subscriptionProvider(guard));
  return models;
}

/**
 * The catalog model used to drive login and auth checks.
 * @param models - the collection.
 * @returns a descriptor on this route, or undefined when the catalog lacks it.
 */
export function subscriptionModel(models) {
  return models.getModel(PROVIDER_ID, 'claude-sonnet-4-5');
}

/**
 * Run the browser OAuth sign-in and persist the result.
 *
 * Persistence is pi-ai's own: `Models.login` writes the credential through the
 * store's `modify`, which is the same serialized path a refresh takes, so a
 * sign-in racing a refresh cannot interleave.
 * @param ctx - the plugin context.
 * @param interaction - pi-ai's interaction surface, adapted to the seam.
 * @returns the stored credential.
 */
export async function loginWithBrowser(ctx, interaction) {
  const models = modelsFor(ctx);
  return await models.login(PROVIDER_ID, 'oauth', {
    signal: interaction.signal,
    notify: interaction.notify,
    prompt: interaction.prompt,
  });
}

/**
 * Resolve a currently valid access token, refreshing it when near expiry.
 *
 * The refresh runs inside `ctx.get('credentials').modifyRecord`, so the
 * read-decide-write span is exclusive across processes. That is what stops two
 * concurrent DSH processes from both rotating the same refresh token and
 * losing whichever grant was written first.
 * @param ctx - the plugin context.
 * @param config - refresh settings.
 * @param signal - caller cancellation.
 * @returns the bearer token.
 * @throws {LlmError} code `NOT_CONFIGURED` when no grant is stored.
 */
export async function resolveAccessToken(ctx, config, signal) {
  const credentials = ctx.get('credentials');
  const key = recordKeyFor(PROVIDER_ID);
  if (credentials === undefined) {
    throw new LlmError(
      'dsh-ccsub: this composition mounts no credentials service, so no sign-in can be stored or read',
      'NO_CREDENTIAL_STORE',
    );
  }
  const record = await credentials.readRecord(key);
  if (record === undefined) {
    throw new LlmError(
      'dsh-ccsub: not signed in. Run the Claude Subscription sign-in from Settings before using this route.',
      'NOT_CONFIGURED',
    );
  }
  const payload = record.kind === 'grant' ? record.payload : undefined;
  if (payload === undefined || payload.type !== 'oauth') {
    throw new LlmError(
      'dsh-ccsub: the stored credential for this route is not an OAuth grant; sign in again with the browser flow.',
      'NOT_CONFIGURED',
    );
  }
  const skew = config.refreshSkewMs ?? DEFAULT_REFRESH_SKEW_MS;
  const expires = typeof payload.expires === 'number' ? payload.expires : 0;
  if (expires - skew > Date.now()) return payload.access;

  // Near or past expiry: refresh under the cross-process lock.
  let refreshed;
  await credentials.modifyRecord(key, async (current) => {
    const live = current?.kind === 'grant' ? current.payload : undefined;
    if (live === undefined || live.type !== 'oauth') return undefined;
    const liveExpires = typeof live.expires === 'number' ? live.expires : 0;
    if (liveExpires - skew > Date.now()) {
      // Another process refreshed while this one waited for the lock.
      refreshed = live.access;
      return undefined;
    }
    const oauth = anthropicProvider().auth.oauth;
    // pi-ai's refresh does `AbortSignal.any([signal, AbortSignal.timeout(...)])`,
    // so a non-signal throws `ERR_INVALID_ARG_TYPE` before any I/O. Substitute a
    // real one whenever the caller has none (the adapter's `resolveApiKey` hook
    // is called with only `(provider, profile)`, so this is the normal path).
    const refreshedUnder =
      signal === undefined ? AbortSignal.timeout(REFRESH_TIMEOUT_MS) : signal;
    const next = await oauth.refresh(live, refreshedUnder);
    refreshed = next.access;
    return { kind: 'grant', payload: JSON.parse(JSON.stringify(next)) };
  });
  if (refreshed === undefined) {
    // The record changed shape underneath us; re-read once rather than guess.
    const again = await credentials.readRecord(key);
    const live = again?.kind === 'grant' ? again.payload : undefined;
    if (live?.type === 'oauth' && typeof live.access === 'string') return live.access;
    throw new LlmError('dsh-ccsub: the stored grant disappeared during refresh', 'NOT_CONFIGURED');
  }
  return refreshed;
}

/**
 * Read the subscription's rate-limit windows.
 *
 * Two response shapes exist and both are read: the newer structured `limits`
 * array, and the older flat `five_hour` / `seven_day*` buckets. The array wins
 * when it carries usable entries.
 *
 * The request is made through `guard.fetch`, so the quota probe is subject to
 * the same mandatory proxy and egress allowlist as a model request — a usage
 * call must not be the one that leaks the real address.
 * @param ctx - the plugin context.
 * @param guard - the egress guard supplying the transport.
 * @param config - refresh settings.
 * @param signal - caller cancellation.
 * @returns the mapped windows.
 */export async function fetchUsage(ctx, guard, config, signal) {
  const access = await resolveAccessToken(ctx, config, signal);
  const response = await guard.fetch(CLAUDE_USAGE_URL, {
    method: 'GET',
    signal,
    headers: {
      authorization: `Bearer ${access}`,
      'anthropic-beta': 'oauth-2025-04-20',
      'user-agent': `claude-cli/${config.claudeCliVersion ?? '2.1.251'}`,
      accept: 'application/json',
    },
  });
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new LlmError(
      `dsh-ccsub: the usage endpoint answered ${response.status}${body.length === 0 ? '' : `: ${body.slice(0, 300)}`}`,
      'USAGE_FAILED',
    );
  }
  const payload = await response.json();
  return mapUsage(payload);
}

/**
 * Map a usage payload onto normalized windows.
 * @param payload - the parsed response body.
 * @returns the windows, newest shape preferred.
 */
export function mapUsage(payload) {
  const modern = limitsWindows(payload?.limits);
  if (modern.length > 0) return { supported: true, windows: modern };
  const windows = [];
  for (const window of [
    legacyWindow(payload?.five_hour, 'session'),
    legacyWindow(payload?.seven_day, 'weekly'),
    legacyWindow(payload?.seven_day_opus, 'weekly', 'Opus'),
    legacyWindow(payload?.seven_day_sonnet, 'weekly', 'Sonnet'),
  ]) {
    if (window !== undefined) windows.push(window);
  }
  return { supported: true, windows };
}

/** RFC3339 `resets_at` → epoch ms, or undefined when absent or unparsable. */
function resetsAt(value) {
  if (typeof value !== 'string' || value.length === 0) return undefined;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/** Map one legacy `{utilization, resets_at}` bucket. */
function legacyWindow(value, kind, scope) {
  if (typeof value !== 'object' || value === null) return undefined;
  if (typeof value.utilization !== 'number' || !Number.isFinite(value.utilization)) return undefined;
  const reset = resetsAt(value.resets_at);
  return {
    kind,
    ...(scope === undefined ? {} : { scope }),
    usedPercent: value.utilization,
    ...(reset === undefined ? {} : { resetsAt: reset }),
  };
}

/** Map the structured `limits` array; empty when absent or unusable. */
function limitsWindows(value) {
  if (!Array.isArray(value)) return [];
  const windows = [];
  for (const raw of value) {
    if (typeof raw !== 'object' || raw === null) continue;
    if (typeof raw.percent !== 'number' || !Number.isFinite(raw.percent)) continue;
    const kind =
      raw.kind === 'session'
        ? 'session'
        : raw.kind === 'weekly_all' || raw.kind === 'weekly_scoped'
          ? 'weekly'
          : 'other';
    const scope = raw.scope?.model?.display_name;
    const reset = resetsAt(raw.resets_at);
    windows.push({
      kind,
      ...(typeof scope === 'string' && scope.length > 0 ? { scope } : {}),
      usedPercent: raw.percent,
      ...(reset === undefined ? {} : { resetsAt: reset }),
    });
  }
  return windows;
}


