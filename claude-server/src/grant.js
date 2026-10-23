/**
 * The grant: the one place a Claude Pro/Max OAuth credential lives.
 *
 * Two properties matter more than anything else here.
 *
 * **Single ownership.** Anthropic rotates the refresh token on every refresh:
 * `refreshAnthropicToken()` returns a new `refresh_token`, and the old one stops
 * working. If two processes refresh the same grant, one of them always loses the
 * rotation. This server is therefore the only refresher — local DSH clients hold
 * a bearer for *this* server, never the Claude token itself.
 *
 * **Single flight within the process.** A refresh is a network round trip, and
 * a burst of concurrent requests would otherwise each start one. `refreshing`
 * collapses them onto one promise so the rotation happens once.
 *
 * @module claude-server/grant
 */

import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Refresh this long before expiry rather than after it. */
const DEFAULT_REFRESH_SKEW_MS = 300_000;

/** The OAuth client id the official CLI authorizes with. */
export const CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

/** Where the token exchange and refresh POST to. */
export const TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

/** The redirect URI the authorize page expects. It need not be listening. */
export const REDIRECT_URI = 'http://localhost:53692/callback';

/** The scope set the official CLI requests. */
export const SCOPES = [
  'org:create_api_key',
  'user:profile',
  'user:inference',
  'user:sessions:claude_code',
  'user:mcp_servers',
  'user:file_upload',
].join(' ');

/**
 * A grant that cannot serve requests and cannot be repaired locally.
 *
 * `code` is stable so the HTTP layer can map it to a status without parsing
 * the message.
 */
export class GrantError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'GrantError';
    this.code = code;
  }
}

/**
 * The durable grant.
 *
 * The file is written with an atomic rename so a crash mid-write cannot leave a
 * truncated token behind, and is chmod 0600 because it is a bearer credential
 * for the user's subscription.
 */
export class GrantStore {
  #path;
  #skewMs;
  #logger;
  #cache;
  #refreshing;

  /**
   * @param options - file path, refresh skew, and a logger.
   */
  constructor(options) {
    this.#path = options.path;
    this.#skewMs = Number(options.refreshSkewMs) || DEFAULT_REFRESH_SKEW_MS;
    this.#logger = options.logger;
    this.#cache = undefined;
    this.#refreshing = undefined;
  }

  /** The absolute path of the grant file. */
  get path() {
    return this.#path;
  }

  /**
   * Read the grant from disk, memoized.
   * @returns the parsed grant, or undefined when none is stored.
   */
  async read() {
    if (this.#cache !== undefined) return this.#cache;
    let text;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') return undefined;
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new GrantError(`the grant file at ${this.#path} is not valid JSON: ${String(error)}`, 'GRANT_CORRUPT');
    }
    if (typeof parsed?.access !== 'string' || typeof parsed?.refresh !== 'string') {
      throw new GrantError(`the grant file at ${this.#path} is missing access or refresh`, 'GRANT_CORRUPT');
    }
    this.#cache = parsed;
    return parsed;
  }

  /**
   * Replace the stored grant atomically.
   * @param grant - the grant to persist.
   */
  async write(grant) {
    const directory = dirname(this.#path);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const temporary = join(directory, `.${process.pid}.${Date.now()}.grant.tmp`);
    await writeFile(temporary, `${JSON.stringify(grant, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, this.#path);
    // `rename` preserves the temp file's mode, but set it explicitly so a
    // pre-existing file with looser permissions is corrected too.
    await chmod(this.#path, 0o600);
    this.#cache = grant;
  }

  /** Forget the memoized grant so the next read hits disk. */
  invalidate() {
    this.#cache = undefined;
  }

  /**
   * Whether a grant is present and not near expiry.
   * @param grant - the grant to inspect.
   * @returns true when the access token can be used as-is.
   */
  #usable(grant) {
    const expires = typeof grant?.expires === 'number' ? grant.expires : 0;
    return expires - this.#skewMs > Date.now();
  }

  /**
   * The access token to send upstream, refreshing when near expiry.
   *
   * Concurrent callers share one refresh. A refresh that fails clears the memo
   * so a later attempt re-reads disk rather than serving a doomed token.
   * @param refresh - the refresh implementation (injected for testability).
   * @returns the bearer token.
   * @throws {GrantError} `NOT_SIGNED_IN` when no grant is stored.
   */
  async accessToken(refresh) {
    const current = await this.read();
    if (current === undefined) {
      throw new GrantError(
        'no Claude subscription is signed in. Run the authorization-code sign-in against this server first.',
        'NOT_SIGNED_IN',
      );
    }
    if (this.#usable(current)) return current.access;
    if (this.#refreshing !== undefined) {
      const settled = await this.#refreshing;
      return settled.access;
    }
    this.#refreshing = (async () => {
      // Re-read: another writer (or an operator) may have replaced the file.
      this.invalidate();
      const live = await this.read();
      if (live === undefined) {
        throw new GrantError('the grant disappeared during refresh', 'NOT_SIGNED_IN');
      }
      if (this.#usable(live)) return live;
      this.#logger?.info('refreshing the Claude subscription grant');
      const next = await refresh(live.refresh);
      const stored = {
        type: 'oauth',
        access: next.access,
        refresh: next.refresh,
        expires: next.expires,
      };
      await this.write(stored);
      return stored;
    })();
    try {
      const settled = await this.#refreshing;
      return settled.access;
    } catch (error) {
      this.invalidate();
      throw error;
    } finally {
      this.#refreshing = undefined;
    }
  }
}
