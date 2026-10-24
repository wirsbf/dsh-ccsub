/**
 * Authorization-code login sessions.
 *
 * One attempt per id, held in memory with a TTL: the operator asks for a URL,
 * opens it, authorizes, and pastes the result back. Nothing listens on the
 * redirect URI, so the pasted value is the only way the code can arrive.
 *
 * The PKCE verifier doubles as the OAuth `state`, exactly as the official
 * client does it. That is what lets a bare pasted code be bound to this
 * attempt: the verifier is only needed at exchange time and never leaves this
 * process, so a code lifted from another session cannot be replayed here
 * without it.
 *
 * @module claude-server/login
 */

import { randomBytes } from 'node:crypto';
import { authorizeUrl, generatePkce } from './oauth.js';

/** A login attempt that expired or was already consumed. */
export class LoginError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'LoginError';
    this.code = code;
  }
}

/**
 * The in-memory attempt registry.
 *
 * Only a handful of attempts can be live at once in practice, so a Map with a
 * size cap is enough; there is no need for eviction policies beyond the cap and
 * the TTL.
 */
export class LoginSessions {
  #ttlMs;
  #sessions;
  #maxLive;

  /**
   * @param options - TTL and the maximum number of live attempts.
   */
  constructor(options) {
    this.#ttlMs = options.ttlMs;
    this.#sessions = new Map();
    this.#maxLive = options.maxLive ?? 4;
  }

  /** Drop expired attempts; called before every read and create. */
  #sweep() {
    const now = Date.now();
    for (const [id, session] of this.#sessions) {
      if (session.expiresAt <= now) this.#sessions.delete(id);
    }
  }

  /**
   * Open one attempt.
   * Open one attempt.
   *
   * `accountId` records which subscription the resulting grant belongs to. It is
   * carried on the attempt rather than supplied again at `/complete`, so the
   * exchange cannot be pointed at a different account than the URL that was
   * shown — the authorize URL the operator actually opened is the binding.
   * @param options - `accountId` the grant will be stored under (null = default).
   * @returns the attempt id and the authorize URL to show the operator.
   * @throws {LoginError} `TOO_MANY_ATTEMPTS` when the cap is reached.
   */
  create({ accountId = null } = {}) {
    this.#sweep();
    if (this.#sessions.size >= this.#maxLive) {
      throw new LoginError(
        'too many sign-in attempts are already pending; finish or cancel one before starting another',
        'TOO_MANY_ATTEMPTS',
      );
    }
    const id = randomBytes(16).toString('hex');
    const { verifier, challenge } = generatePkce();
    const url = authorizeUrl(challenge, verifier);
    const session = {
      verifier,
      url,
      accountId: accountId === undefined ? null : accountId,
      expiresAt: Date.now() + this.#ttlMs,
    };
    this.#sessions.set(id, session);
    return { id, url, accountId: session.accountId, expiresAt: session.expiresAt };
  }

  /**
   * Read one attempt without consuming it, so the operator can re-read the URL.
   * @param id - the attempt id.
   * @returns the attempt.
   * @throws {LoginError} `UNKNOWN_ATTEMPT` when absent or expired.
   */
  peek(id) {
    this.#sweep();
    const session = this.#sessions.get(String(id ?? ''));
    if (session === undefined) {
      throw new LoginError('that sign-in attempt is unknown or has expired; start a new one', 'UNKNOWN_ATTEMPT');
    }
    return session;
  }

  /**
   * Consume one attempt. A code may be exchanged exactly once.
   * @param id - the attempt id.
   * @returns the attempt.
   * @throws {LoginError} `UNKNOWN_ATTEMPT` when absent or expired.
   */
  consume(id) {
    const session = this.peek(id);
    this.#sessions.delete(String(id));
    return session;
  }

  /** How many attempts are live. */
  get size() {
    this.#sweep();
    return this.#sessions.size;
  }
}
