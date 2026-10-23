/**
 * Request-body sanitisation.
 *
 * The local plugin already removes these identity strings, so in the normal
 * path this module finds nothing to do. It exists anyway because the two sides
 * are separate processes that can be updated independently: a client that is
 * older, newer, or configured differently must not be able to leak the harness
 * brand through this server.
 *
 * ## Scope
 *
 * Only `POST /v1/messages` bodies are inspected, and only the `system` array is
 * rewritten. `messages` is left alone because a user may legitimately be
 * discussing these very words — rewriting a conversation would corrupt it.
 *
 * ## Ordering is semantic
 *
 * The rules run longest-first. If the generic brand rule ran before the
 * identity sentence, the sentence would become `The the harness …`: the brand
 * token inside `The DeepSeek Harness …` would be replaced while the leading
 * article stayed. This was reproduced during design, hence the explicit order
 * below and the comment on the array.
 *
 * Paths are deliberately **not** rewritten. A workspace path is functional
 * input — the model uses it to read and edit files — and the install path is
 * informational, so both are preserved here by operator decision.
 *
 * @module claude-server/sanitize
 */

/**
 * Ordered replacement rules: identity sentences before generic brand tokens.
 * @type {Array<[RegExp, string]>}
 */
export const SYSTEM_RULES = [
  // 1. The harness identity sentence, whole.
  [/You are an AI agent powered by DeepSeek Harness\.?/g, 'You are a coding agent.'],
  // 2. The source-checkout sentence's lead-in, leaving its path untouched.
  [/The DeepSeek Harness implementation checkout is at/g,
   'The harness implementation checkout is at'],
  // 3. Any remaining brand token. Must stay last.
  [/DeepSeek Harness/g, 'the harness'],
];

/**
 * Apply the rules to one string.
 * @param text - the input.
 * @returns the rewritten text and the number of rules that matched.
 */
export function sanitizeText(text) {
  if (typeof text !== 'string' || text.length === 0) return { text, hits: 0 };
  let out = text;
  let hits = 0;
  for (const [pattern, replacement] of SYSTEM_RULES) {
    if (!pattern.test(out)) continue;
    pattern.lastIndex = 0;
    out = out.replace(pattern, replacement);
    hits += 1;
  }
  return { text: out, hits };
}

/**
 * Sanitise a request body.
 *
 * A body that does not parse, has no `system` array, or carries no block list
 * is returned **unchanged** — this function never turns a working request into
 * a failing one. Failures are reported so the caller can log them.
 *
 * @param raw - the raw request body (a JSON string or bytes).
 * @returns the body to send, plus what was changed.
 */
export function sanitizeBody(raw) {
  const original = typeof raw === 'string' ? raw : raw === undefined ? undefined : String(raw);
  if (original === undefined || original.length === 0) {
    return { body: raw, hits: 0, parsed: false, changed: false };
  }
  let parsed;
  try {
    parsed = JSON.parse(original);
  } catch {
    // Not JSON: pass through untouched rather than break the request.
    return { body: raw, hits: 0, parsed: false, changed: false };
  }
  if (parsed === null || typeof parsed !== 'object' || !Array.isArray(parsed.system)) {
    return { body: raw, hits: 0, parsed: true, changed: false };
  }
  let hits = 0;
  const system = parsed.system.map((block) => {
    if (block === null || typeof block !== 'object' || typeof block.text !== 'string') return block;
    const result = sanitizeText(block.text);
    hits += result.hits;
    return result.hits === 0 ? block : { ...block, text: result.text };
  });
  if (hits === 0) return { body: raw, hits: 0, parsed: true, changed: false };
  // Re-serialise only when something changed, so byte-identical bodies stay
  // byte-identical (key order and spacing are preserved on the pass-through).
  return { body: JSON.stringify({ ...parsed, system }), hits, parsed: true, changed: true };
}
