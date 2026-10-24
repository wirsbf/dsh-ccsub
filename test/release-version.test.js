/**
 * The release-version rule, exercised without touching a repository.
 *
 * The workflow only calls this script once per release, on `main`, after a
 * merge — which is the worst possible place to discover that an edge case picks
 * the wrong number. The cases below are the ones that have a wrong answer worth
 * getting: a wrongly *lower* version strands installed clients, because pnpm
 * treats the older tarball as already satisfied and never upgrades.
 */

import assert from 'node:assert/strict';
import test from 'node:test';
import { nextVersion, withVersion, MANIFESTS } from '../scripts/release-version.mjs';

test('a manifest at the newest tag releases the next patch', () => {
  assert.deepEqual(nextVersion('0.2.2', 'v0.2.2'), {
    version: '0.2.3',
    kind: 'patch',
    previous: 'v0.2.2',
  });
});

test('the patch carries over a zero, rather than resetting the minor', () => {
  assert.equal(nextVersion('0.2.9', 'v0.2.9').version, '0.2.10');
  assert.equal(nextVersion('1.0.0', 'v1.0.0').version, '1.0.1');
});

test('a manifest ahead of the tag is the writer\'s own bump and is released as-is', () => {
  // This is how the minor digit moves: the writer edits package.json, and the
  // release must not add a patch on top of the number they chose.
  assert.deepEqual(nextVersion('0.3.0', 'v0.2.2'), {
    version: '0.3.0',
    kind: 'manual',
    previous: 'v0.2.2',
  });
  assert.equal(nextVersion('1.0.0', 'v0.9.9').kind, 'manual');
});

test('a manifest ahead by a patch is also manual, not incremented twice', () => {
  // A writer who raises only the patch still gets exactly that number.
  assert.equal(nextVersion('0.2.5', 'v0.2.2').version, '0.2.5');
});

test('the first release ships the manifest unchanged', () => {
  assert.deepEqual(nextVersion('0.2.2', ''), {
    version: '0.2.2',
    kind: 'initial',
    previous: '',
  });
  assert.equal(nextVersion('0.2.2', undefined).kind, 'initial');
});

test('a manifest below the newest tag advances from the tag, not the manifest', () => {
  // Reverting or dropping a bump commit leaves the manifest behind. Releasing
  // the lower number would make the tag list non-monotonic, and pnpm compares
  // versions rather than tags, so every client would stay on the newer build.
  const decided = nextVersion('0.2.2', 'v0.3.0');
  assert.equal(decided.version, '0.3.1');
  assert.equal(decided.kind, 'patch');
  assert.match(decided.warning, /below the newest tag v0\.3\.0/);
});

test('a final manifest above a prerelease tag promotes that prerelease', () => {
  // `0.2.2` sorts above `0.2.2-rc.1`, so this is the manual path: releasing
  // `0.2.2` is the promotion. Adding a patch here would ship `0.2.3` and leave
  // `0.2.2` forever unreleased.
  const decided = nextVersion('0.2.2', 'v0.2.2-rc.1');
  assert.equal(decided.version, '0.2.2');
  assert.equal(decided.kind, 'manual');
});

test('a manifest level with a prerelease advances the patch above it', () => {
  // Here the manifest is the prerelease itself, so the next release is the
  // patch above it.
  const decided = nextVersion('0.2.2-rc.1', 'v0.2.2-rc.1');
  assert.equal(decided.version, '0.2.3');
  assert.equal(decided.kind, 'patch');
});

test('a tag without the v prefix is understood', () => {
  assert.equal(nextVersion('0.2.2', '0.2.2').version, '0.2.3');
});

test('an unparsable manifest version is an error, not a silent 0.0.1', () => {
  assert.throws(() => nextVersion('not-a-version', 'v0.2.2'), /not a version/);
  assert.throws(() => nextVersion('', 'v0.2.2'), /not a version/);
});

test('rewriting the version leaves the rest of the manifest byte-identical', () => {
  const source = '{\n  "name": "x",\n  "version": "0.2.2",\n  "private": true\n}\n';
  const written = withVersion(source, '0.2.3');
  assert.equal(written, '{\n  "name": "x",\n  "version": "0.2.3",\n  "private": true\n}\n');
  // Idempotent: applying the same version again changes nothing.
  assert.equal(withVersion(written, '0.2.3'), written);
});

test('rewriting only touches the top-level version, not a nested one', () => {
  const source = '{\n  "version": "0.2.2",\n  "config": { "version": "9.9.9" }\n}\n';
  assert.match(withVersion(source, '0.2.3'), /"version": "0\.2\.3",\n  "config": \{ "version": "9\.9\.9"/);
});

test('a manifest with no version field is an error', () => {
  assert.throws(() => withVersion('{"name":"x"}', '1.0.0'), /no version field/);
});

test('both manifests are released under one version', () => {
  // The server image tag and the plugin tarball share the number, so the list
  // is what the workflow rewrites and what a release is named after.
  assert.deepEqual(MANIFESTS, ['package.json', 'claude-server/package.json']);
});

// --- decideRelease: what a run does, including when it is a re-run ---
//
// A re-run of an already-successful release is the case that must not publish
// twice. `reuseTagOf` recovers "this is the same run" from the marker the first
// attempt stamped into its tag, because git history alone cannot tell a re-run
// from a new push.

import { decideRelease, reuseTagOf } from '../scripts/release-version.mjs';

test('a fresh run releases the next patch above the newest tag', () => {
  assert.deepEqual(decideRelease({ current: '0.2.2', latestTag: 'v0.2.2' }), {
    version: '0.2.3',
    kind: 'patch',
    previous: 'v0.2.2',
    reuse: false,
  });
});

test('a re-run completes the release its first attempt tagged', () => {
  // The trap: without the reuse signal this decides 0.2.4 above the tag its own
  // earlier attempt pushed, publishing a release nobody asked for.
  const decided = decideRelease({ current: '0.2.3', latestTag: 'v0.2.3', reuseTag: '0.2.3' });
  assert.equal(decided.version, '0.2.3');
  assert.equal(decided.kind, 'existing');
  assert.equal(decided.reuse, true);
});

test('an explicit version wins over both the tag and a reuse signal', () => {
  const decided = decideRelease({ current: '0.2.2', latestTag: 'v0.2.2', reuseTag: '0.2.2', forced: '0.5.0' });
  assert.equal(decided.version, '0.5.0');
  assert.equal(decided.kind, 'explicit');
  assert.equal(decided.reuse, false);
});

test('an empty reuse signal means a fresh run, not reuse of version ""', () => {
  assert.equal(decideRelease({ current: '0.2.2', latestTag: 'v0.2.2', reuseTag: '' }).reuse, false);
  assert.equal(decideRelease({ current: '0.2.2', latestTag: 'v0.2.2', reuseTag: '  ' }).reuse, false);
  assert.equal(decideRelease({ current: '0.2.2', latestTag: 'v0.2.2' }).reuse, false);
});

test('an unparsable reuse signal is an error rather than a released version', () => {
  assert.throws(() => decideRelease({ current: '0.2.2', latestTag: 'v0.2.2', reuseTag: 'nope' }), /not a version/);
});

test('a run-id marker in a tag names that tag, and only for that run', () => {
  const tags = [
    { tag: 'v0.2.4', message: 'Release 0.2.4\n\nRelease-Run: 2002\n' },
    { tag: 'v0.2.3', message: 'Release 0.2.3\n\nRelease-Run: 1001\n' },
  ];
  assert.equal(reuseTagOf(tags, '1001'), '0.2.3');
  assert.equal(reuseTagOf(tags, '2002'), '0.2.4');
  // A different run is a new push: it must not adopt another run's release.
  assert.equal(reuseTagOf(tags, '3003'), undefined);
  assert.equal(reuseTagOf(tags, ''), undefined);
  assert.equal(reuseTagOf([], '1001'), undefined);
});

test('a marker that is only a prefix of the run id does not match', () => {
  const tags = [{ tag: 'v0.2.3', message: 'Release-Run: 10011\n' }];
  assert.equal(reuseTagOf(tags, '1001'), undefined);
  assert.equal(reuseTagOf(tags, '10011'), '0.2.3');
});

test('the marker survives a tag whose annotation has other lines around it', () => {
  const tags = [
    { tag: 'v1.2.3', message: 'Release 1.2.3 [skip ci]\n\nBody text.\n\nRelease-Run: 777\n\nTrailing.\n' },
  ];
  assert.equal(reuseTagOf(tags, '777'), '1.2.3');
});
