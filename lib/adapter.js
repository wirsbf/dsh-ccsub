/**
 * The `claude-sub` route adapter.
 *
 * ## Why this reuses `PiAiAdapter`
 *
 * pi-ai already speaks Anthropic Messages, and — crucially — its Anthropic
 * client switches to the *subscription* request shape by itself when the
 * credential looks like an OAuth token: it sends `x-app: cli`, the
 * `claude-code-20250219` / `oauth-2025-04-20` beta set, and injects the
 * literal leading system block `You are Claude Code, Anthropic's official CLI
 * for Claude.` Re-implementing that here would mean maintaining a copy of
 * undocumented behaviour that Anthropic can change at any time.
 *
 * So this adapter reuses `PiAiAdapter` for the whole request and stream
 * translation and swaps exactly one thing: the provider handed to pi-ai's
 * `Models`, whose `api` is wrapped to inject our egress-guarded transport.
 *
 * ## Why not reuse the `anthropic` route
 *
 * `dsh-llm-pi-ai` builds request headers as `requestHeaders(profile.headers)`,
 * which merges `attributionHeaders()` **last** and filters profile headers
 * whose names collide case-insensitively with the reserved attribution names.
 * On the shared `anthropic` route the harness User-Agent therefore always wins
 * on the wire and a subscription identity cannot be kept self-consistent.
 * Registering our own route lets this plugin own the header set, and the guard
 * restores the client identity as the final step before dispatch.
 *
 * @module dsh-ccsub/adapter
 */

import { PiAiAdapter } from '@deepseek-ai/dsh-llm-pi-ai';
import { resolveRetryPolicy } from '@deepseek-ai/dsh-llm';
import { defaultProviderAuthContext, InMemoryCredentialStore } from '@earendil-works/pi-ai';
import { PROVIDER_ID } from './auth/store.js';
import { subscriptionProvider } from './auth/claude.js';

/** Image budgets and idle timeout, matching the harness defaults. */
const DEFAULT_STREAM_IDLE_TIMEOUT_MS = 300_000;
const DEFAULT_MAX_REQUEST_IMAGE_BYTES = 20_971_520;
const DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET = 4_194_304;
const DEFAULT_REQUEST_IMAGE_MAX_BYTES = 1_048_576;

/**
 * Build the profile `PiAiAdapter` reads for this route.
 *
 * Every field the adapter dereferences without a guard is supplied here, so a
 * change to the adapter's assumptions surfaces in review rather than as a
 * crash on the first request.
 * @param provider - the guarded provider, carrying the catalog.
 * @param config - the per-route configuration.
 * @returns the profile.
 */
export function profileFor(provider, config) {
  return {
    provider: PROVIDER_ID,
    displayName: 'Claude Subscription',
    piProvider: provider,
    headers: {},
    // Empty collections are the adapter's own "no per-model override" encoding.
    modelErrors: new Map(),
    configuredMaxTokens: new Map(),
    streamIdleTimeoutMs: config.streamIdleTimeoutMs ?? DEFAULT_STREAM_IDLE_TIMEOUT_MS,
    maxRequestImageBytes: config.maxRequestImageBytes ?? DEFAULT_MAX_REQUEST_IMAGE_BYTES,
    requestImagePixelBudget: config.requestImagePixelBudget ?? DEFAULT_REQUEST_IMAGE_PIXEL_BUDGET,
    requestImageMaxBytes: config.requestImageMaxBytes ?? DEFAULT_REQUEST_IMAGE_MAX_BYTES,
    retryPolicy: resolveRetryPolicy(config.retryPolicy, `ccsub/${PROVIDER_ID}`),
  };
}

/**
 * Create the adapter for the `claude-sub` route.
 *
 * `profiles` is read per request and rebuilt when the configuration revision
 * changes. Rebuilding rather than mutating matters because the adapter
 * recognises an unchanged configuration by identity: returning the same map
 * keeps the cached pi-ai `Models` collection, and returning a new one makes it
 * rebuild — which is how a settings change reaches the next request without
 * re-registering the adapter (a second registration would throw).
 * @param options - the plugin's live dependencies.
 * @returns the adapter to register with `ctx.llm`.
 */
export function createAdapter(options) {
  const { guard, provider, resolveApiKey, resolveAttachments, profileConfig } = options;
  /** Provider may be an instance or a factory returning the current one. */
  const providerFor =
    typeof provider === 'function'
      ? provider
      : () => provider ?? subscriptionProvider(guard);
  let shared = providerFor();
  let lastFactoryResult = shared;
  let profiles;
  let revision;

  const currentProfiles = () => {
    const next = profileConfig?.();
    // A provider factory may return a fresh instance (e.g. after the declared
    // context window changed in settings); rebuild the profile map then.
    const candidate = providerFor();
    if (profiles === undefined || next !== revision || candidate !== lastFactoryResult) {
      shared = candidate;
      lastFactoryResult = candidate;
      revision = next;
      profiles = new Map([[PROVIDER_ID, profileFor(shared, next ?? {})]]);
    }
    return profiles;
  };

  return new PiAiAdapter({
    profiles: currentProfiles,
    resolveApiKey,
    auth: {
      // This adapter's own `Models` never resolves auth from a store: the token
      // arrives through `resolveApiKey`, which is where the refresh lock lives.
      credentials: new InMemoryCredentialStore(),
      authContext: defaultProviderAuthContext(),
    },
    ...(resolveAttachments === undefined ? {} : { resolveAttachments }),
  });
}
