/**
 * The user directory: who may use this server, and who may administer it.
 *
 * ## Why there is a file at all
 *
 * The client bearer used to be exactly one value in the environment, which meant
 * revoking one client meant rotating the credential for every client at once.
 * A directory separates identity from configuration: each user gets their own
 * token, and disabling one user leaves everybody else working.
 *
 * ## Why only a hash is stored
 *
 * The file sits on the same volume as the grant, which is a credential store.
 * A plaintext token there would be recoverable by anyone who can read the
 * volume, and would be recoverable again after every backup. Only
 * `sha256(token)` is persisted, so the file is enough to *check* a token and
 * useless for *presenting* one. The plaintext is returned exactly once, by
 * `create()`, and no later read can recover it.
 *
 * A hash of a long random token needs no salt: the token space is 256 bits, so
 * the usual argument for salting (a dictionary of likely inputs) does not
 * apply. Salting each row would also make lookups a per-row hash instead of one
 * hash plus constant-time comparisons.
 *
 * ## Why the read is memoized
 *
 * Every relayed request verifies a token, and the directory is read on that
 * path. Re-reading the file for each request would put the volume in the hot
 * path for no benefit: the file only changes through this process, and every
 * mutation refreshes the memo. `invalidate()` exists so an operator (or a test)
 * can force a re-read after touching the file by hand.
 *
 * ## Why a corrupt file does not fail a request
 *
 * `verify()` treats an unreadable directory as "nothing matches". The relay is
 * the reason this server exists; a malformed users file should not take it down
 * for every caller including the legacy bearer. Mutations still refuse loudly,
 * because silently rewriting a file we could not parse would destroy it.
 *
 * @module claude-server/users
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { chmod, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

/** Version of the on-disk format. A future shape change bumps this. */
export const USERS_VERSION = 1;

/** Token prefix. Makes a leaked token greppable in logs and recognisable. */
export const TOKEN_PREFIX = 'ccs_';

/** The id of the synthesized user that represents `CLIENT_BEARER`. */
export const LEGACY_USER_ID = 'legacy';

/** The display name of the synthesized legacy user. */
export const LEGACY_USER_NAME = 'Legacy bearer (CLIENT_BEARER)';

/** Longest accepted user name. Storage is small and names are for humans. */
const MAX_NAME_LENGTH = 64;

/**
 * A token: the prefix plus the unpadded base64url of 32 random bytes.
 *
 * Nothing accepts a token that does not have this shape, which keeps malformed
 * input (including the empty string) from reaching a comparison at all.
 */
const TOKEN_PATTERN = /^ccs_[A-Za-z0-9_-]{43}$/;

/** Minimal gap between two persisted `lastUsedAt` updates for one user. */
const LAST_USED_WRITE_MS = 5 * 60_000;

/** The two roles, and what they mean beyond the name. */
const ROLES = new Set(['admin', 'client']);

/** Control characters are refused in names: they break logs and tables. */
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

/**
 * A user-directory failure with a stable code.
 *
 * The HTTP layer maps `code` to a status rather than parsing messages, exactly
 * like `GrantError`.
 */
export class UsersError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'UsersError';
    this.code = code;
  }
}

/**
 * Hash one token for storage or comparison.
 * @param token - the plaintext token.
 * @returns the lowercase hex sha256 digest.
 */
export function hashToken(token) {
  return createHash('sha256').update(String(token), 'utf8').digest('hex');
}

/**
 * Whether a string has the shape this server issues.
 * @param token - the candidate.
 * @returns true when it could be a token from `create()`.
 */
export function isTokenShaped(token) {
  return typeof token === 'string' && TOKEN_PATTERN.test(token);
}

/**
 * The synthesized entry for the environment bearer.
 *
 * It is never stored: it exists so every serialized list has the same shape and
 * the operator can see that the bootstrap credential is live.
 * @returns the public legacy user.
 */
export function legacyUser() {
  return {
    id: LEGACY_USER_ID,
    name: LEGACY_USER_NAME,
    role: 'admin',
    createdAt: null,
    lastUsedAt: null,
    disabled: false,
    legacy: true,
  };
}

/** Validate and normalize a display name. */
function normalizeName(raw) {
  if (typeof raw !== 'string') {
    throw new UsersError('a user name is required', 'INVALID_NAME');
  }
  const name = raw.trim();
  if (name.length === 0) {
    throw new UsersError('a user name must not be empty', 'INVALID_NAME');
  }
  if (name.length > MAX_NAME_LENGTH) {
    throw new UsersError(`a user name must be at most ${MAX_NAME_LENGTH} characters`, 'INVALID_NAME');
  }
  if (CONTROL_CHARACTERS.test(name)) {
    throw new UsersError('a user name must not contain control characters', 'INVALID_NAME');
  }
  return name;
}

/** Validate a role. */
function normalizeRole(raw) {
  if (typeof raw !== 'string' || !ROLES.has(raw)) {
    throw new UsersError('a role must be "admin" or "client"', 'INVALID_ROLE');
  }
  return raw;
}

/** Validate a `disabled` flag. */
function normalizeDisabled(raw) {
  if (typeof raw !== 'boolean') {
    throw new UsersError('"disabled" must be a boolean', 'INVALID_DISABLED');
  }
  return raw;
}

/**
 * Validate the account a token spends.
 *
 * `undefined` and `null` both mean the default account. The id's *existence* is
 * checked by the caller that owns the account directory: this module cannot see
 * that file, and inventing a second source of truth here would let the two
 * disagree.
 */
function normalizeAccountId(raw) {
  if (raw === undefined || raw === null) return null;
  if (typeof raw !== 'string' || raw.trim().length === 0) {
    throw new UsersError('"accountId" must be a non-empty string or null', 'INVALID_ACCOUNT');
  }
  const clean = raw.trim();
  if (!/^[a-z0-9_]{1,40}$/.test(clean)) {
    throw new UsersError('"accountId" is not a usable account id', 'INVALID_ACCOUNT');
  }
  return clean;
}

/** One stored record, normalized, or a corrupt-file error. */
function normalizeStoredUser(record, index) {
  if (record === null || typeof record !== 'object') {
    throw new UsersError(`the user file entry ${index} is not an object`, 'USERS_CORRUPT');
  }
  const { id, name, tokenHash, createdAt, lastUsedAt, disabled, role, accountId } = record;
  if (typeof id !== 'string' || id.length === 0) {
    throw new UsersError(`the user file entry ${index} has no id`, 'USERS_CORRUPT');
  }
  if (id === LEGACY_USER_ID) {
    // `legacy` is reserved for the environment bearer. A record claiming that id
    // would shadow a credential the operator cannot see in this file.
    throw new UsersError('the user file claims the reserved legacy id', 'USERS_CORRUPT');
  }
  if (typeof name !== 'string' || name.length === 0) {
    throw new UsersError(`the user file entry ${index} has no name`, 'USERS_CORRUPT');
  }
  if (typeof tokenHash !== 'string' || !/^[0-9a-f]{64}$/.test(tokenHash)) {
    throw new UsersError(`the user file entry ${index} has no usable token hash`, 'USERS_CORRUPT');
  }
  if (role !== 'admin' && role !== 'client') {
    throw new UsersError(`the user file entry ${index} has an unknown role`, 'USERS_CORRUPT');
  }
  // Absent or null means the default account: every token issued before
  // accounts existed resolves to the grant that was the only one at the time,
  // so an upgrade must not invalidate them. A present value must be a usable id.
  if (accountId !== undefined && accountId !== null) {
    if (typeof accountId !== 'string' || !/^[a-z0-9_]{1,40}$/.test(accountId)) {
      throw new UsersError(`the user file entry ${index} has an unusable account id`, 'USERS_CORRUPT');
    }
  }
  return {
    id,
    name,
    role,
    tokenHash,
    accountId: accountId === undefined ? null : accountId,
    createdAt: typeof createdAt === 'number' ? createdAt : 0,
    lastUsedAt: typeof lastUsedAt === 'number' ? lastUsedAt : null,
    disabled: disabled === true,
  };
}

/** The public view of a stored user: everything except the hash. */
function publicUser(user) {
  return {
    id: user.id,
    name: user.name,
    role: user.role,
    // `null` means the default account. The console renders that as a name
    // rather than an empty cell, so a pre-accounts token is not a mystery row.
    accountId: user.accountId ?? null,
    createdAt: user.createdAt,
    lastUsedAt: user.lastUsedAt,
    disabled: user.disabled === true,
    legacy: false,
  };
}

/**
 * The durable user directory.
 *
 * Writes are atomic (temp file plus rename) and serialized inside the process,
 * so two mutations cannot interleave into a lost update. Reads are memoized
 * until a mutation or an explicit `invalidate()`.
 */
export class UserDirectory {
  #path;
  #logger;
  #cache;
  #lastUsedWrites = new Map();
  #mutationChain = Promise.resolve();
  #persistChain = Promise.resolve();
  #corruptReported = false;

  /**
   * @param options - the file path and a logger.
   * @throws {UsersError} when the path is missing.
   */
  constructor(options = {}) {
    if (typeof options.path !== 'string' || options.path.trim().length === 0) {
      throw new UsersError('the user directory needs a file path', 'USERS_PATH_MISSING');
    }
    this.#path = options.path;
    this.#logger = options.logger;
    this.#cache = undefined;
  }

  /** The absolute path of the user file. */
  get path() {
    return this.#path;
  }

  /**
   * Read the directory from disk, memoized.
   *
   * A missing file is an empty directory, not an error: a fresh deployment has
   * no users until the operator adds one, and the file is created lazily on the
   * first write.
   * @returns the parsed directory.
   * @throws {UsersError} `USERS_CORRUPT` when the file exists but cannot be used.
   */
  async #read() {
    if (this.#cache !== undefined) return this.#cache;
    let text;
    try {
      text = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error?.code === 'ENOENT') {
        this.#cache = { version: USERS_VERSION, users: [] };
        return this.#cache;
      }
      throw error;
    }
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch (error) {
      throw new UsersError(`the user file at ${this.#path} is not valid JSON: ${String(error)}`, 'USERS_CORRUPT');
    }
    if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.users)) {
      throw new UsersError(`the user file at ${this.#path} has no users array`, 'USERS_CORRUPT');
    }
    this.#cache = {
      version: USERS_VERSION,
      users: parsed.users.map((record, index) => normalizeStoredUser(record, index)),
    };
    this.#corruptReported = false;
    return this.#cache;
  }

  /** Replace the file with the current in-memory directory, atomically. */
  #write() {
    const snapshot = {
      version: USERS_VERSION,
      users: (this.#cache?.users ?? []).map((user) => ({ ...user })),
    };
    const run = async () => {
      const directory = dirname(this.#path);
      await mkdir(directory, { recursive: true, mode: 0o700 });
      const temporary = join(directory, `.${process.pid}.${Date.now()}.users.tmp`);
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await rename(temporary, this.#path);
      // `rename` keeps the temp file's mode, but chmod explicitly so a file that
      // already existed with looser permissions is corrected too.
      await chmod(this.#path, 0o600);
    };
    // Serialize writes: two renames from the same process would otherwise race on
    // which snapshot is final. A failed write must not poison the chain.
    const next = this.#persistChain.then(run, run);
    this.#persistChain = next.catch(() => {});
    return next;
  }

  /**
   * Run one read-modify-write mutation, serialized against other mutations.
   * @param mutate - callback that edits the cached directory in place.
   * @returns whatever the callback returns.
   */
  async #mutate(mutate) {
    const previous = this.#mutationChain;
    let release;
    this.#mutationChain = new Promise((resolve) => {
      release = resolve;
    });
    await previous.catch(() => {});
    try {
      const directory = await this.#read();
      const result = await mutate(directory);
      await this.#write();
      return result;
    } finally {
      release();
    }
  }

  /**
   * List every user.
   *
   * The legacy bearer comes first because it is the bootstrap credential and the
   * operator should see it before the accounts they added. The rest are ordered
   * by creation time, which makes the table stable across edits.
   * @returns public users, without token hashes.
   * @throws {UsersError} `USERS_CORRUPT` when the file cannot be used.
   */
  async list() {
    const directory = await this.#read();
    const stored = [...directory.users].sort((a, b) => a.createdAt - b.createdAt);
    return [legacyUser(), ...stored.map(publicUser)];
  }

  /**
   * Add one user and issue its token.
   *
   * The token is returned exactly once. It is not stored in plaintext, so this
   * is the caller's only chance to show it.
   * @param options - `name`, and an optional `role` (default `client`).
   * @returns the public user and the plaintext token.
   */
  async create({ name, role, accountId } = {}) {
    const cleanName = normalizeName(name);
    const cleanRole = normalizeRole(role === undefined ? 'client' : role);
    const cleanAccount = normalizeAccountId(accountId);
    const token = `${TOKEN_PREFIX}${randomBytes(32).toString('base64url')}`;
    const created = {
      id: '',
      name: cleanName,
      role: cleanRole,
      tokenHash: hashToken(token),
      accountId: cleanAccount,
      createdAt: Date.now(),
      lastUsedAt: null,
      disabled: false,
    };
    await this.#mutate((directory) => {
      do {
        // 12 hex characters is 48 bits: collisions are not a concern in
        // practice, but a duplicate id would make every lookup ambiguous.
        created.id = `u_${randomBytes(6).toString('hex')}`;
      } while (directory.users.some((user) => user.id === created.id));
      directory.users.push(created);
      return undefined;
    });
    this.#logger?.info(
      'added user %s with role %s on account %s',
      created.id,
      created.role,
      created.accountId ?? 'default',
    );
    return { user: publicUser(created), token };
  }

  /**
   * Change one user.
   * @param id - the user id.
   * @param patch - `name`, `role`, `disabled`, and/or `accountId` (null = default).
   * @returns the updated public user.
   * @throws {UsersError} `LEGACY_USER` for the reserved id, `UNKNOWN_USER` when absent.
   */
  async update(id, patch = {}) {
    if (id === LEGACY_USER_ID) {
      throw new UsersError('the legacy bearer is configured by the environment, not by this file', 'LEGACY_USER');
    }
    const nextName = patch.name === undefined ? undefined : normalizeName(patch.name);
    const nextRole = patch.role === undefined ? undefined : normalizeRole(patch.role);
    const nextDisabled = patch.disabled === undefined ? undefined : normalizeDisabled(patch.disabled);
    const nextAccount = patch.accountId === undefined ? undefined : normalizeAccountId(patch.accountId);
    return await this.#mutate((directory) => {
      const user = directory.users.find((candidate) => candidate.id === id);
      if (user === undefined) {
        throw new UsersError('that user does not exist', 'UNKNOWN_USER');
      }
      if (nextName !== undefined) user.name = nextName;
      if (nextRole !== undefined) user.role = nextRole;
      if (nextDisabled !== undefined) user.disabled = nextDisabled;
      if (nextAccount !== undefined) user.accountId = nextAccount;
      this.#logger?.info(
        'updated user %s (role=%s disabled=%s account=%s)',
        user.id,
        user.role,
        user.disabled === true ? 'yes' : 'no',
        user.accountId ?? 'default',
      );
      return publicUser(user);
    });
  }

  /**
   * Remove one user.
   * @param id - the user id.
   * @returns true when a user was removed, false when the id was unknown.
   * @throws {UsersError} `LEGACY_USER` for the reserved id.
   */
  async remove(id) {
    if (id === LEGACY_USER_ID) {
      throw new UsersError('the legacy bearer cannot be removed; unset CLIENT_BEARER instead', 'LEGACY_USER');
    }
    const removed = await this.#mutate((directory) => {
      const at = directory.users.findIndex((candidate) => candidate.id === id);
      if (at < 0) return false;
      directory.users.splice(at, 1);
      return true;
    });
    if (removed) {
      this.#lastUsedWrites.delete(id);
      this.#logger?.info('removed user %s', id);
    }
    return removed;
  }

  /**
   * Identify the user behind a token.
   *
   * Every stored hash is compared in constant time; the scan does not stop on the
   * first match, so the work done does not depend on which user (if any) matched.
   * Disabled users still take part in the comparison and are only discarded
   * afterwards, so disabling a user is not observable through timing.
   * @param token - the plaintext token.
   * @returns the identity, or undefined when no enabled user owns the token.
   */
  async verify(token) {
    // The format is public, so rejecting a non-token early leaks nothing and
    // keeps arbitrary input away from the comparison.
    if (!isTokenShaped(token)) return undefined;
    const presented = createHash('sha256').update(token, 'utf8').digest();
    let found;
    let directory;
    try {
      directory = await this.#read();
    } catch (error) {
      this.#reportCorrupt(error);
      return undefined;
    }
    for (const user of directory.users) {
      const stored = Buffer.from(user.tokenHash, 'hex');
      if (stored.length !== presented.length) continue;
      if (!timingSafeEqual(stored, presented)) continue;
      if (user.disabled === true) continue;
      if (found === undefined) found = user;
    }
    if (found === undefined) return undefined;
    await this.#touch(found);
    return {
      id: found.id,
      name: found.name,
      role: found.role,
      // The account this token spends. `null` is the default account, which is
      // what every token issued before accounts existed belongs to.
      accountId: found.accountId ?? null,
    };
  }

  /**
   * Record that a user just authenticated.
   *
   * This is throttled per user in memory rather than written on every request:
   * the relay verifies a token per call, and a write per call would put the
   * volume in the request path for a field that only has to be roughly right.
   * A failed write is logged and swallowed — activity tracking must never turn
   * a working request into a failure.
   * @param user - the matched stored user (mutated in place).
   */
  async #touch(user) {
    const now = Date.now();
    const last = this.#lastUsedWrites.get(user.id) ?? 0;
    if (now - last < LAST_USED_WRITE_MS) return;
    this.#lastUsedWrites.set(user.id, now);
    user.lastUsedAt = now;
    try {
      await this.#write();
    } catch (error) {
      this.#logger?.warn('could not record activity for user %s: %s', user.id, String(error));
    }
  }

  /** Log a corrupt directory once, rather than on every verification. */
  #reportCorrupt(error) {
    if (this.#corruptReported) return;
    this.#corruptReported = true;
    this.#logger?.warn(
      'the user file at %s is unusable, so no stored user can authenticate: %s',
      this.#path,
      String(error?.message ?? error),
    );
  }

  /** Forget the memoized directory so the next read hits disk. */
  invalidate() {
    this.#cache = undefined;
    this.#lastUsedWrites.clear();
    this.#corruptReported = false;
  }
}
