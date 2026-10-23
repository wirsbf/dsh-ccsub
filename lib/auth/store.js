/**
 * The credential plane for the `claude-sub` route.
 *
 * Records live under this plugin's own scope (`ccsub`), deliberately separate
 * from `llm-pi-ai`'s records: a user may sign into the same account through
 * either route, and two writers sharing one record would fight.
 *
 * The important property here is that pi-ai performs an OAuth refresh *inside*
 * `modify()`. Routing that through `ctx.get('credentials').modifyRecord()` makes the
 * read-decide-write span a network round trip under a lock that holds across
 * processes — which is what stops two DSH processes from rotating one refresh
 * token and losing whichever wrote first.
 *
 * @module dsh-ccsub/auth/store
 */

import { homedir } from 'node:os';
import { resolve as resolvePath } from 'node:path';
import { access } from 'node:fs/promises';
import {
  credentialKey,
  credentialRef,
  isCredentialKeySegment,
  isCredentialRefName,
} from '@deepseek-ai/dsh-credentials';
import { LlmError } from '@deepseek-ai/dsh-llm';

/** The record scope this plugin owns. */
export const RECORD_SCOPE = 'ccsub';
/** The single provider route this plugin serves. */
export const PROVIDER_ID = 'claude-sub';

/**
 * The record address for one route.
 * @param providerId - the route key.
 * @returns the scoped credential key.
 */
export function recordKeyFor(providerId) {
  return credentialKey(RECORD_SCOPE, providerId);
}

/**
 * Convert a stored record into the pi-ai credential union.
 * @param record - the stored record, or undefined.
 * @returns the pi-ai credential, or undefined for an absent record.
 */
export function toPiCredential(record) {
  if (record === undefined) return undefined;
  if (record.kind === 'api-key') {
    return {
      type: 'api_key',
      ...(record.key === undefined ? {} : { key: record.key }),
      ...(record.env === undefined ? {} : { env: { ...record.env } }),
    };
  }
  return record.payload;
}

/**
 * Convert a pi-ai credential into the record to store.
 * @param credential - what a login or refresh produced.
 * @returns the record to commit.
 */
export function toRecord(credential) {
  if (credential.type === 'api_key') {
    return {
      kind: 'api-key',
      ...(credential.key === undefined ? {} : { key: credential.key }),
      ...(credential.env === undefined ? {} : { env: { ...credential.env } }),
    };
  }
  return { kind: 'grant', payload: jsonImage(credential) };
}

/**
 * Render one credential as plain JSON, matching what `JSON.stringify` would
 * produce. pi-ai credentials idiomatically carry optional members as explicit
 * `undefined`, which must not reach the durable store.
 * @param value - the credential.
 * @returns the JSON-safe image.
 */
function jsonImage(value) {
  return JSON.parse(JSON.stringify(value ?? null));
}

/**
 * The credential service, or the failure naming what is missing.
 *
 * Reads answer "nothing stored" without a service, because a composition with
 * no credential plane genuinely holds no credential. Writes refuse, because a
 * login whose grant silently evaporated would report success and then fail
 * every request.
 * @param ctx - the plugin context.
 * @returns the live credential service.
 * @throws {LlmError} code `NO_CREDENTIAL_STORE` when none is mounted.
 */
export function writableStore(ctx) {
  const credentials = ctx.get('credentials');
  if (credentials === undefined) {
    throw new LlmError(
      'dsh-ccsub: this composition mounts no credentials service, so there is nowhere to store the credential a sign-in produces; mount dsh-credentials-local to sign in',
      'NO_CREDENTIAL_STORE',
    );
  }
  return credentials;
}

/**
 * A pi-ai `CredentialStore` over the harness credential records.
 * @param ctx - the plugin context carrying the optional `ctx.get('credentials')`.
 * @returns the store to hand `createModels()`.
 */
export function credentialStoreFrom(ctx, options = {}) {
  // `fallbackRead` lets a caller supply the credential for a provider record
  // that is deliberately empty. In `claude-server` mode this process holds no
  // Claude grant — `ccsub/claude-sub` is blank by design — but pi-ai's
  // `Models.refresh()` reads exactly that record to decide whether the network
  // is allowed. Without a substitute the catalog refresh returns before it ever
  // calls `fetchModels`, which is how a current model went missing from the
  // picker. The fallback returns a pi-ai credential for such a record.
  const fallbackRead = options.fallbackRead;
  return {
    async read(providerId) {
      const credentials = ctx.get('credentials');
      if (credentials === undefined) return undefined;
      if (!isCredentialKeySegment(providerId)) return undefined;
      const stored = toPiCredential(await credentials.readRecord(recordKeyFor(providerId)));
      if (stored !== undefined) return stored;
      if (typeof fallbackRead !== 'function') return undefined;
      return await fallbackRead(providerId);
    },
    async list() {
      const stored = (await ctx.get('credentials')?.listRecords()) ?? [];
      const mine = [];
      for (const entry of stored) {
        const key = String(entry.key);
        if (!key.startsWith(`${RECORD_SCOPE}/`)) continue;
        mine.push({
          providerId: key.slice(RECORD_SCOPE.length + 1),
          type: entry.kind === 'api-key' ? 'api_key' : 'oauth',
        });
      }
      return mine;
    },
    async modify(providerId, mutate) {
      if (!isCredentialKeySegment(providerId)) {
        throw new LlmError(
          `dsh-ccsub: provider id "${providerId}" cannot address a stored credential record`,
          'UNSTORABLE_PROVIDER_ID',
        );
      }
      return toPiCredential(
        await writableStore(ctx).modifyRecord(recordKeyFor(providerId), async (current) => {
          const next = await mutate(toPiCredential(current));
          return next === undefined ? undefined : toRecord(next);
        }),
      );
    },
    async delete(providerId) {
      if (!isCredentialKeySegment(providerId)) return;
      await writableStore(ctx).deleteRecord(recordKeyFor(providerId));
    },
  };
}

/**
 * A pi-ai `AuthContext` over the harness credential plane and the host
 * filesystem.
 *
 * `env()` answers from the credential seam first so a value a deployment
 * stored through the harness is found by a provider's own ambient discovery,
 * then falls back to the process environment. `fileExists()` answers about the
 * host process's filesystem, because the paths it is asked about are facts
 * about where this process runs rather than about the project under edit.
 * @param ctx - the plugin context.
 * @returns the auth context to hand `createModels()`.
 */
export function authContextFrom(ctx) {
  return {
    async env(name) {
      if (isCredentialRefName(name)) {
        const hit = await ctx.get('credentials')?.resolve(credentialRef(name));
        if (hit !== undefined) return hit.value;
      }
      const value = process.env[name];
      return value === undefined || value === '' ? undefined : value;
    },
    async fileExists(path) {
      const expanded =
        path.startsWith('~/') || path === '~'
          ? resolvePath(homedir(), path.slice(1).replace(/^\//, ''))
          : path;
      try {
        await access(expanded);
        return true;
      } catch {
        return false;
      }
    },
  };
}

/**
 * Describe the stored grant for a status surface, without exposing the token.
 * @param record - the stored record.
 * @returns presence and expiry facts.
 */
export function describeGrant(record) {
  if (record === undefined) return { configured: false };
  const payload = record.kind === 'grant' ? record.payload : undefined;
  const access = typeof payload?.access === 'string' ? payload.access : undefined;
  const expires = typeof payload?.expires === 'number' ? payload.expires : undefined;
  return {
    configured: true,
    kind: record.kind,
    subscription: access !== undefined && access.includes('sk-ant-oat'),
    expiresAt: expires ?? null,
  };
}
