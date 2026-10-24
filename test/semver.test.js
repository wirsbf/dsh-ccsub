/**
 * The dependency-drift range check.
 *
 * This is the one piece of the drift alarm that is pure logic, and it is the
 * piece that decides whether the plugin warns about a harness that will fail
 * later at stream time. The cases below are the shapes that actually appear:
 * the harness's own peer range (`0.2.1-rc.2` style unions) and the caret range
 * that a private pi-ai copy would be pinned by.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { compareParsed, parseVersion, satisfiesRange } from '../lib/semver.js';

test('parseVersion reads prerelease tails', () => {
  assert.deepEqual(parseVersion('1.1.0'), { major: 1, minor: 1, patch: 0, pre: '' });
  assert.deepEqual(parseVersion('0.2.1-rc.2'), { major: 0, minor: 2, patch: 1, pre: 'rc.2' });
  assert.deepEqual(parseVersion('v3.18.5'), { major: 3, minor: 18, patch: 5, pre: '' });
});

test('a prerelease sorts below the release it leads to', () => {
  assert.equal(compareParsed(parseVersion('1.0.0-rc.1'), parseVersion('1.0.0')), -1);
  assert.equal(compareParsed(parseVersion('1.0.0'), parseVersion('1.0.0-rc.1')), 1);
  assert.equal(compareParsed(parseVersion('1.0.0'), parseVersion('1.0.0')), 0);
});

test('caret pins the minor for 0.x, the major for 1.x', () => {
  // ^0.87.1 is the range that pinned a private pi-ai into the profile at 0.87.x.
  assert.equal(satisfiesRange('0.87.1', '^0.87.1'), true);
  assert.equal(satisfiesRange('0.87.9', '^0.87.1'), true);
  assert.equal(satisfiesRange('0.88.0', '^0.87.1'), false);
  // ^1.1.0 accepts later minors.
  assert.equal(satisfiesRange('1.1.0', '^1.1.0'), true);
  assert.equal(satisfiesRange('1.9.0', '^1.1.0'), true);
  assert.equal(satisfiesRange('2.0.0', '^1.1.0'), false);
});

test('the harness peer range accepts the pi-ai it ships', () => {
  const range = '>=0.87.1 <2';
  assert.equal(satisfiesRange('1.1.0', range), true);
  assert.equal(satisfiesRange('0.87.1', range), true);
  assert.equal(satisfiesRange('2.0.0', range), false);
  assert.equal(satisfiesRange('0.87.0', range), false);
});

test('a version union range matches any of its clauses', () => {
  const range = '0.2.0-rc.1 || 0.2.0-rc.2 || 0.2.1-rc.2';
  assert.equal(satisfiesRange('0.2.1-rc.2', range), true);
  assert.equal(satisfiesRange('0.2.0-rc.2', range), true);
  assert.equal(satisfiesRange('0.2.0', range), false);
});

test('tilde pins the minor', () => {
  assert.equal(satisfiesRange('3.18.5', '~3.18.4'), true);
  assert.equal(satisfiesRange('3.19.0', '~3.18.4'), false);
});

test('an unparsable range is unknown rather than incompatible', () => {
  // Reporting false here would be a false alarm about a working install.
  assert.equal(satisfiesRange('1.1.0', 'latest'), undefined);
  assert.equal(satisfiesRange('1.1.0', 'workspace:*'), undefined);
  assert.equal(satisfiesRange('1.1.0', ''), undefined);
});

test('an unparsable version is unknown, not a silent 0.0.0', () => {
  // `Number.parseInt` would coerce this to 0 and confidently report
  // "incompatible" against any real range.
  assert.equal(satisfiesRange('not-a-version', '^1.0.0'), undefined);
  assert.equal(satisfiesRange('', '^1.0.0'), undefined);
});
