/**
 * Session affinity: keep a conversation on one subscription.
 *
 * ## Why a session must not move
 *
 * Prompt cache is per credential. Every request that lands on a *different*
 * account pays a full cache write (1.25x input) instead of a cache read (0.1x),
 * so a conversation that hops accounts costs roughly twelve times what it would
 * cost staying put. The whole point of routing is to move the *start* of a
 * conversation to a roomy account, never the middle of one.
 *
 * ## What identifies a session
 *
 * Anthropic request bodies carry no session id and the client sends no header
 * for one, so the identity is derived from the parts of the body that stay
 * fixed for the life of a conversation:
 *
 * - `system` — the harness prompt, identical on every turn
 * - `tools` — the tool schema, identical on every turn
 * - `messages[0]` — the opening turn, which never changes after it is sent
 *
 * Later turns append to `messages`, so keying on the *first* message rather than
 * the whole array is what makes every turn of one conversation produce the same
 * fingerprint. Keying on the whole array would give every turn a new key and
 * defeat the binding entirely.
 *
 * ## Collisions
 *
 * Two conversations with the same system prompt, the same tools, and the same
 * opening message are indistinguishable from here and share a binding. That is
 * acceptable: they would also share a cache, so treating them as one session
 * costs nothing.
 *
 * @module claude-server/sessions
 */

import { createHash } from 'node:crypto';

/** Drop a binding this long after its last request. */
const DEFAULT_TTL_MS = 30 * 60_000;

/** Hard cap on live bindings, so a long uptime cannot grow without bound. */
const DEFAULT_MAX_SESSIONS = 4096;

/**
 * A stable fingerprint for the conversation a request belongs to.
 *
 * Returns undefined when the body carries nothing to key on — a call with no
 * `system`, no `tools` and no messages cannot be attributed, and inventing a
 * key from nothing would put unrelated calls in one bucket.
 * @param body - the parsed request body.
 * @returns a short hex fingerprint, or undefined.
 */
export function fingerprintOf(body) {
  if (body === null || typeof body !== 'object') return undefined;
  const system = body.system;
  const tools = body.tools;
  const messages = Array.isArray(body.messages) ? body.messages : undefined;
  const first = messages !== undefined && messages.length > 0 ? messages[0] : undefined;
  if (system === undefined && tools === undefined && first === undefined) return undefined;

  // JSON.stringify is order-stable for the objects Anthropic bodies contain,
  // and the client rebuilds these fields identically each turn.
  // Model first: it is the cheapest discriminator and the one that decides
  // whether a cache entry can be reused at all.
  const material = JSON.stringify([body.model ?? null, system ?? null, tools ?? null, first ?? null]);
  return createHash('sha256').update(material).digest('hex').slice(0, 32);
}

/**
 * The binding table.
 *
 * In memory only: a restart forgets which conversation was on which account,
 * and the next turn of an in-flight conversation starts a fresh binding. That
 * costs one cache write, which is the correct trade for not persisting routing
 * state into the grant volume.
 */
export class SessionBindings {
  #map = new Map();
  #ttlMs;
  #max;

  /**
   * @param options - `ttlMs` and `max` overrides, mainly for tests.
   */
  constructor(options = {}) {
    this.#ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    this.#max = options.max ?? DEFAULT_MAX_SESSIONS;
  }

  /** Drop bindings whose last request is older than the TTL. */
  #sweep() {
    const cutoff = Date.now() - this.#ttlMs;
    for (const [key, entry] of this.#map) {
      if (entry.lastSeen <= cutoff) this.#map.delete(key);
    }
  }

  /**
   * The account a conversation is bound to.
   * @param fingerprint - from `fingerprintOf`.
   * @returns the account id, or undefined when unbound or expired.
   */
  get(fingerprint) {
    if (typeof fingerprint !== 'string') return undefined;
    const entry = this.#map.get(fingerprint);
    if (entry === undefined) return undefined;
    if (entry.lastSeen <= Date.now() - this.#ttlMs) {
      this.#map.delete(fingerprint);
      return undefined;
    }
    return entry.accountId;
  }

  /**
   * Bind a conversation to an account and mark it as just used.
   * @param fingerprint - from `fingerprintOf`.
   * @param accountId - the account serving it.
   */
  set(fingerprint, accountId) {
    if (typeof fingerprint !== 'string' || typeof accountId !== 'string') return;
    if (this.#map.size >= this.#max) {
      this.#sweep();
      // Still full after sweeping: evict the least recently used entry rather
      // than refusing to bind, because refusing would send this conversation
      // hopping between accounts and cost a cache write per turn.
      if (this.#map.size >= this.#max) {
        let oldestKey;
        let oldestAt = Infinity;
        for (const [key, entry] of this.#map) {
          if (entry.lastSeen < oldestAt) {
            oldestAt = entry.lastSeen;
            oldestKey = key;
          }
        }
        if (oldestKey !== undefined) this.#map.delete(oldestKey);
      }
    }
    this.#map.set(fingerprint, { accountId, lastSeen: Date.now() });
  }

  /** Forget one binding, e.g. after its account was exhausted. */
  delete(fingerprint) {
    if (typeof fingerprint === 'string') this.#map.delete(fingerprint);
  }

  /** How many bindings are live (after sweeping expired ones). */
  get size() {
    this.#sweep();
    return this.#map.size;
  }

  /** Forget everything (exposed for tests). */
  clear() {
    this.#map.clear();
  }
}
