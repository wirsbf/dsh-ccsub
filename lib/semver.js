/**
 * Minimal semver comparison for the dependency-drift check.
 *
 * This is not a general implementation: it handles exactly the comparator
 * shapes this plugin reasons about, because the range it reads comes from
 * another package's manifest and cannot be assumed to be a bare caret. It
 * lives in its own module so it can be unit-tested without the harness.
 *
 * @module dsh-ccsub/semver
 */

/**
 * Split a version into numeric parts plus its prerelease tail.
 * @param version - a version string such as `1.1.0` or `0.2.1-rc.2`.
 * @returns the parsed parts; `major` is NaN when the text is not a version, so
 *   callers can report "unknown" instead of comparing against 0.0.0.
 */
export function parseVersion(version) {
  const text = String(version).trim().replace(/^v/, '');
  const [core, ...pre] = text.split('-');
  const parts = core.split('.');
  // A version has at least a major, and no part may be non-numeric: letting
  // `Number.parseInt` coerce "not-a-version" to 0 would report a bogus 0.0.0
  // and turn a parse failure into a confident "incompatible".
  if (parts.length === 0 || !parts.every((part) => /^\d+$/.test(part))) {
    return { major: Number.NaN, minor: Number.NaN, patch: Number.NaN, pre: '' };
  }
  const [major, minor = 0, patch = 0] = parts.map((part) => Number.parseInt(part, 10));
  return { major, minor, patch, pre: pre.join('-') };
}

/** Compare two parsed versions: negative, zero, or positive like a sort key. */
export function compareParsed(a, b) {
  for (const key of ['major', 'minor', 'patch']) {
    if (a[key] !== b[key]) return a[key] - b[key];
  }
  // A prerelease sorts *below* the release it leads to: 1.0.0-rc.1 < 1.0.0.
  if (a.pre === b.pre) return 0;
  if (a.pre === '') return 1;
  if (b.pre === '') return -1;
  return a.pre < b.pre ? -1 : 1;
}

/**
 * Does `version` satisfy `range`?
 *
 * Handles the comparator shapes this plugin actually reasons about — `||`
 * unions of space-separated comparators, `^`, `~`, and the `>= <= > < =`
 * operators — because the range comes from another package's manifest and
 * cannot be assumed to be a bare caret. Anything unparsable is treated as
 * "unknown" (`undefined`) rather than silently reported as incompatible, so a
 * range this helper does not understand never produces a false alarm.
 * @param version - the version to test.
 * @param range - the range expression.
 * @returns true, false, or undefined when the range is not understood.
 */
export function satisfiesRange(version, range) {
  const parsed = parseVersion(version);
  if (!Number.isFinite(parsed.major)) return undefined;
  let understood = false;
  for (const clause of String(range).split('||')) {
    const comparators = clause.trim().split(/\s+/).filter(Boolean);
    if (comparators.length === 0) continue;
    const checks = [];
    for (const token of comparators) {
      const m = /^(\^|~|>=|<=|>|<|=)?\s*v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?$/.exec(token);
      if (m === null) {
        checks.length = 0;
        break;
      }
      const operator = m[1] ?? '=';
      const base = {
        major: Number(m[2]),
        minor: Number(m[3] ?? 0),
        patch: Number(m[4] ?? 0),
        pre: m[5] ?? '',
      };
      if (operator === '^') {
        // ^0.87.1 pins the minor, ^1.1.0 pins the major, ^0.0.3 pins the patch.
        const upper =
          base.major > 0
            ? { major: base.major + 1, minor: 0, patch: 0, pre: '' }
            : base.minor > 0
              ? { major: 0, minor: base.minor + 1, patch: 0, pre: '' }
              : { major: 0, minor: 0, patch: base.patch + 1, pre: '' };
        checks.push((v) => compareParsed(v, base) >= 0 && compareParsed(v, upper) < 0);
      } else if (operator === '~') {
        const upper = { major: base.major, minor: base.minor + 1, patch: 0, pre: '' };
        checks.push((v) => compareParsed(v, base) >= 0 && compareParsed(v, upper) < 0);
      } else if (operator === '>=') checks.push((v) => compareParsed(v, base) >= 0);
      else if (operator === '<=') checks.push((v) => compareParsed(v, base) <= 0);
      else if (operator === '>') checks.push((v) => compareParsed(v, base) > 0);
      else if (operator === '<') checks.push((v) => compareParsed(v, base) < 0);
      else checks.push((v) => compareParsed(v, base) === 0);
    }
    if (checks.length === 0) continue;
    understood = true;
    if (checks.every((check) => check(parsed))) return true;
  }
  return understood ? false : undefined;
}
