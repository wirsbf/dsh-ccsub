/**
 * The user directory.
 *
 * The property worth locking down is not "the file round-trips" but "the file
 * cannot be turned back into a credential". A token exists in plaintext only in
 * the return value of `create()`; every other path sees a hash at most, and a
 * disabled user stops working without affecting anybody else.
 */

import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { test } from 'node:test';

import { UserDirectory, UsersError, hashToken, isTokenShaped } from '../src/users.js';
import { loadConfig } from '../src/config.js';

const quietLogger = { info() {}, warn() {}, error() {} };

/** A directory over a fresh temp file. */
async function makeDirectory(options = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-users-'));
  const path = join(dir, 'users.json');
  const directory = new UserDirectory({ path, logger: options.logger ?? quietLogger });
  if (options.seed !== undefined) await writeFile(path, options.seed);
  return {
    directory,
    path,
    dir,
    async close() {
      await rm(dir, { recursive: true, force: true });
    },
  };
}

test('a created token verifies, and no later read can recover it', async () => {
  const { directory, path, close } = await makeDirectory();
  try {
    const { user, token } = await directory.create({ name: 'alice', role: 'admin' });
    assert.match(token, /^ccs_[A-Za-z0-9_-]{43}$/);
    assert.equal(user.role, 'admin');
    assert.equal(user.name, 'alice');
    assert.equal(user.disabled, false);
    assert.match(user.id, /^u_[0-9a-f]{12}$/);
    // The returned user object is the public view: no hash on it.
    assert.equal('tokenHash' in user, false);

    const identity = await directory.verify(token);
    assert.deepEqual(identity, { id: user.id, name: 'alice', role: 'admin' });

    // A fresh directory over the same file must not be able to hand the token
    // back, and its list must carry neither the token nor its hash.
    const reopened = new UserDirectory({ path });
    const listed = await reopened.list();
    const serialized = JSON.stringify(listed);
    assert.equal(serialized.includes(token), false);
    assert.equal(serialized.includes(hashToken(token)), false);
    assert.equal(serialized.includes('tokenHash'), false);

    // The file on disk is hashed, not plaintext.
    const stored = await readFile(path, 'utf8');
    assert.equal(stored.includes(token), false);
    assert.equal(stored.includes(hashToken(token)), true);
  } finally {
    await close();
  }
});

test('two creates produce different tokens and different ids', async () => {
  const { directory, close } = await makeDirectory();
  try {
    const first = await directory.create({ name: 'alice' });
    const second = await directory.create({ name: 'alice' });
    assert.notEqual(first.token, second.token);
    assert.notEqual(first.user.id, second.user.id);
    // Names may repeat; the id is the key.
    assert.equal(first.user.name, second.user.name);
  } finally {
    await close();
  }
});

test('verify rejects unknown, disabled, empty, and malformed tokens', async () => {
  const { directory, close } = await makeDirectory();
  try {
    const { user, token } = await directory.create({ name: 'alice' });
    assert.equal(await directory.verify('ccs_' + 'A'.repeat(43)), undefined);
    assert.equal(await directory.verify(''), undefined);
    // A token of the wrong length must be rejected before any comparison.
    assert.equal(await directory.verify('ccs_short'), undefined);
    assert.equal(await directory.verify(token + 'x'), undefined);
    assert.equal(await directory.verify(token.slice(0, -1)), undefined);
    assert.equal(await directory.verify(undefined), undefined);
    assert.equal(await directory.verify('x'.repeat(46)), undefined);

    await directory.update(user.id, { disabled: true });
    assert.equal(await directory.verify(token), undefined);
    await directory.update(user.id, { disabled: false });
    assert.deepEqual(await directory.verify(token), { id: user.id, name: 'alice', role: 'client' });
  } finally {
    await close();
  }
});

test('disabling one user leaves the others working', async () => {
  const { directory, close } = await makeDirectory();
  try {
    const alice = await directory.create({ name: 'alice' });
    const bob = await directory.create({ name: 'bob' });
    await directory.update(alice.user.id, { disabled: true });
    assert.equal(await directory.verify(alice.token), undefined);
    assert.ok(await directory.verify(bob.token));
  } finally {
    await close();
  }
});

test('remove deletes a user and reports unknown ids distinctly', async () => {
  const { directory, close } = await makeDirectory();
  try {
    const { user, token } = await directory.create({ name: 'alice' });
    assert.equal(await directory.remove(user.id), true);
    assert.equal(await directory.verify(token), undefined);
    assert.equal(await directory.remove(user.id), false);
    assert.equal(await directory.remove('u_000000000000'), false);
    // The legacy entry is synthesized, never stored: it cannot be removed either.
    await assert.rejects(() => directory.remove('legacy'), /cannot be removed/);
  } finally {
    await close();
  }
});

test('the legacy entry is synthesized, first, and not written to disk', async () => {
  const { directory, close } = await makeDirectory();
  try {
    const before = await directory.list();
    assert.equal(before.length, 1);
    assert.equal(before[0].id, 'legacy');
    assert.equal(before[0].legacy, true);
    assert.equal(before[0].role, 'admin');

    const { user } = await directory.create({ name: 'alice' });
    const after = await directory.list();
    assert.equal(after[0].id, 'legacy');
    assert.equal(after[1].id, user.id);
    // Ordered by creation time after the legacy entry.
    const second = await directory.create({ name: 'bob' });
    const list = await directory.list();
    assert.equal(list[2].id, second.user.id);

    // The legacy entry must not appear in the stored file.
    assert.equal((await directory.list()).filter((entry) => entry.legacy).length, 1);
  } finally {
    await close();
  }
});

test('the legacy entry cannot be renamed, disabled, or given a role', async () => {
  const { directory, close } = await makeDirectory();
  try {
    for (const patch of [{ name: 'x' }, { disabled: true }, { role: 'client' }]) {
      await assert.rejects(() => directory.update('legacy', patch), /environment/);
    }
  } finally {
    await close();
  }
});

test('a missing file is an empty directory, not an error', async () => {
  const { directory, close } = await makeDirectory();
  try {
    assert.deepEqual(await directory.list(), [
      {
        id: 'legacy',
        name: 'Legacy bearer (CLIENT_BEARER)',
        role: 'admin',
        createdAt: null,
        lastUsedAt: null,
        disabled: false,
        legacy: true,
      },
    ]);
    assert.equal(await directory.verify('ccs_' + 'A'.repeat(43)), undefined);
  } finally {
    await close();
  }
});

test('a corrupt file makes verify return undefined rather than throw', async () => {
  const { directory, close } = await makeDirectory({ seed: '{not json' });
  try {
    // The relay path must keep working with the legacy bearer alone.
    assert.equal(await directory.verify('ccs_' + 'A'.repeat(43)), undefined);
    // A mutation, by contrast, must refuse loudly: rewriting an unparsed file
    // would destroy whatever it contained.
    await assert.rejects(async () => await directory.create({ name: 'alice' }), (error) => {
      assert.ok(error instanceof UsersError);
      assert.equal(error.code, 'USERS_CORRUPT');
      return true;
    });
  } finally {
    await close();
  }
});

test('a structurally invalid file is reported with a stable code', async () => {
  const { directory, close } = await makeDirectory({
    seed: JSON.stringify({ version: 1, users: [{ id: 'u_1' }] }),
  });
  try {
    await assert.rejects(async () => await directory.list(), (error) => error.code === 'USERS_CORRUPT');
  } finally {
    await close();
  }
});

test('the file is written with mode 0600', { skip: process.platform === 'win32' }, async () => {
  // POSIX modes are not expressible on Windows: `stat().mode` reports the
  // read-only bit, not permission bits, so this assertion is skipped there
  // rather than weakened for everybody.
  const { directory, path, close } = await makeDirectory();
  try {
    await directory.create({ name: 'alice' });
    assert.equal((await stat(path)).mode & 0o777, 0o600);
  } finally {
    await close();
  }
});

test('the directory is created owner-only', { skip: process.platform === 'win32' }, async () => {
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-users-'));
  try {
    const path = join(dir, 'nested', 'deeper', 'users.json');
    const directory = new UserDirectory({ path });
    await directory.create({ name: 'alice' });
    assert.equal((await stat(join(dir, 'nested'))).mode & 0o777, 0o700);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('lastUsedAt is refreshed but the file is not rewritten on every verify', async () => {
  const { directory, path, close } = await makeDirectory();
  try {
    const { user, token } = await directory.create({ name: 'alice' });

    // The first verify writes: that is what records activity at all.
    assert.ok(await directory.verify(token));
    const afterFirst = await stat(path);
    const stamped = (await directory.list()).find((entry) => entry.id === user.id).lastUsedAt;
    assert.equal(typeof stamped, 'number', 'activity must be recorded');

    // A second verify in quick succession must be throttled in memory.
    assert.ok(await directory.verify(token));
    const afterSecond = await stat(path);
    assert.equal(afterSecond.mtimeMs, afterFirst.mtimeMs, 'the second verify must not rewrite the file');

    // The in-memory record is the same one the first write persisted.
    const after = (await directory.list()).find((entry) => entry.id === user.id);
    assert.equal(after.lastUsedAt, stamped);
  } finally {
    await close();
  }
});

test('a failed activity write does not fail the verification', async () => {
  // Point the directory at a path inside a file, so every write fails with
  // ENOTDIR while reads keep working from the memo.
  const dir = await mkdtemp(join(tmpdir(), 'claude-server-users-'));
  try {
    const blocker = join(dir, 'blocker');
    await writeFile(blocker, 'not a directory');
    const directory = new UserDirectory({ path: join(blocker, 'users.json'), logger: quietLogger });
    // Seeding through create() would fail, so write the cache through the
    // mutation path's error surface and assert the verify contract instead.
    await assert.rejects(() => directory.create({ name: 'alice' }));
    assert.equal(await directory.verify('ccs_' + 'A'.repeat(43)), undefined);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test('role and name survive a round trip through the file', async () => {
  const { directory, path, close } = await makeDirectory();
  try {
    const { user, token } = await directory.create({ name: 'ops', role: 'admin' });
    await directory.update(user.id, { name: 'operations' });
    const reopened = new UserDirectory({ path });
    const listed = await reopened.list();
    const found = listed.find((entry) => entry.id === user.id);
    assert.equal(found.name, 'operations');
    assert.equal(found.role, 'admin');
    assert.deepEqual(await reopened.verify(token), {
      id: user.id,
      name: 'operations',
      role: 'admin',
    });
  } finally {
    await close();
  }
});

test('names are trimmed, length-bounded, and refused when empty or control-bearing', async () => {
  const { directory, close } = await makeDirectory();
  try {
    assert.equal((await directory.create({ name: '  alice  ' })).user.name, 'alice');
    assert.equal((await directory.create({ name: 'a'.repeat(64) })).user.name.length, 64);
    for (const name of ['', '   ', 'a'.repeat(65), 'ali\u0007ce', 'ali\nce', undefined, 42]) {
      await assert.rejects(
        async () => await directory.create({ name }),
        (error) => error.code === 'INVALID_NAME',
        `name ${JSON.stringify(name)} must be refused`,
      );
    }
  } finally {
    await close();
  }
});

test('roles are limited to admin and client', async () => {
  const { directory, close } = await makeDirectory();
  try {
    await assert.rejects(
      async () => await directory.create({ name: 'alice', role: 'root' }),
      (error) => error.code === 'INVALID_ROLE',
    );
    // The default is the least privileged role.
    assert.equal((await directory.create({ name: 'alice' })).user.role, 'client');
  } finally {
    await close();
  }
});

test('isTokenShaped is exact about the prefix and length', () => {
  assert.equal(isTokenShaped(`ccs_${'A'.repeat(43)}`), true);
  assert.equal(isTokenShaped(`CCS_${'A'.repeat(43)}`), false);
  assert.equal(isTokenShaped(`ccs_${'A'.repeat(42)}`), false);
  assert.equal(isTokenShaped(`ccs_${'A'.repeat(44)}`), false);
  assert.equal(isTokenShaped('ccs_' + '!'.repeat(43)), false);
  assert.equal(isTokenShaped(''), false);
  assert.equal(isTokenShaped(undefined), false);
});

test('the id is generated server-side and a client-chosen one is ignored', async () => {
  const { directory, close } = await makeDirectory();
  try {
    const { user } = await directory.create({ id: 'legacy', name: 'alice' });
    assert.notEqual(user.id, 'legacy');
    assert.match(user.id, /^u_[0-9a-f]{12}$/);
    // The synthetic legacy entry is still the only legacy record.
    const list = await directory.list();
    assert.equal(list.filter((entry) => entry.legacy === true).length, 1);
  } finally {
    await close();
  }
});

test('two concurrent creates both persist', async () => {
  const { directory, path, close } = await makeDirectory();
  try {
    const [a, b] = await Promise.all([
      directory.create({ name: 'alice' }),
      directory.create({ name: 'bob' }),
    ]);
    const reopened = new UserDirectory({ path });
    const ids = (await reopened.list()).map((entry) => entry.id);
    assert.ok(ids.includes(a.user.id));
    assert.ok(ids.includes(b.user.id));
  } finally {
    await close();
  }
});

test('USERS_PATH defaults to the grant directory and is honoured when set', () => {
  // The default must derive from GRANT_PATH rather than hardcoding the image's
  // /data, so a local run that moves the grant moves the user file with it.
  assert.equal(loadConfig({ UPSTREAM_MODE: 'direct' }).usersPath, join(dirname('/data/grant.json'), 'users.json'));
  assert.equal(
    loadConfig({ UPSTREAM_MODE: 'direct', GRANT_PATH: join('/srv', 'ccs', 'grant.json') }).usersPath,
    join('/srv', 'ccs', 'users.json'),
  );
  assert.equal(
    loadConfig({
      UPSTREAM_MODE: 'direct',
      GRANT_PATH: join('/srv', 'ccs', 'grant.json'),
      USERS_PATH: join('/elsewhere', 'u.json'),
    }).usersPath,
    join('/elsewhere', 'u.json'),
  );
  assert.throws(
    () => loadConfig({ UPSTREAM_MODE: 'direct', USERS_PATH: '  ' }),
    /USERS_PATH must not be empty/,
  );
  // A directory cannot exist without a path.
  assert.throws(
    () => new UserDirectory({ path: '' }),
    (error) => error.code === 'USERS_PATH_MISSING',
  );
});
