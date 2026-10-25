/**
 * The reply for `GET /quota`, decided from a quota-gate snapshot.
 *
 * A module of its own rather than a function inside `lib/index.js` for two
 * reasons: it has no dependencies, so it can be unit-tested without the host's
 * peer packages, and it is the one place where the two consumers of the quota
 * gate disagree about what a failed probe means.
 *
 * `lastError` is **sticky** on the gate on purpose: the throttle must not
 * mistake a stale reading for a fresh one when deciding whether to park a
 * request, so it keeps the error until a probe succeeds. The card is a different
 * consumer — it renders whatever windows are known. Reporting 502 while still
 * holding those windows made the panel swap real numbers for an error line and
 * then swap them back on the next poll: the flash between "Could not read
 * usage" and the quota meters.
 *
 * So a failure is only a 502 when there is nothing to show. With windows in
 * hand the reply is a normal 200 carrying `staleError`, which the card renders
 * as a note beside the figures rather than instead of them.
 *
 * @module dsh-ccsub/quota-reply
 */

/**
 * Turn a quota-gate snapshot into an HTTP reply.
 * @param snapshot - the result of `quotaGate.snapshot()`, possibly absent.
 * @returns `{ status, body }` to hand to `sendJson`.
 */
export function quotaReply(snapshot) {
  const windows = Array.isArray(snapshot?.windows) ? snapshot.windows : [];
  const lastError = snapshot?.lastError ?? null;
  if (lastError !== null && windows.length === 0) {
    return { status: 502, body: { error: lastError, code: 'USAGE_FAILED' } };
  }
  return {
    status: 200,
    body: {
      supported: true,
      windows,
      fetchedAt: snapshot?.fetchedAt ?? 0,
      // Present only when the last probe failed, so a card can mark the figures
      // stale without treating their absence as an error.
      ...(lastError === null ? {} : { staleError: lastError }),
    },
  };
}
