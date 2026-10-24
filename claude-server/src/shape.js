/**
 * The cache-relevant shape of a request body.
 *
 * ## Why a hash and not the content
 *
 * Prompt cache is prefix-matched, so the question "did this request's prefix
 * match the previous request's" is answerable from whether the bytes are equal.
 * Keeping the bytes would mean holding a copy of every prompt in memory for the
 * life of the process; keeping a digest answers the same question in 16 bytes.
 *
 * ## What the parts mean
 *
 * Anthropic builds the cacheable prefix in the order `tools` → `system` →
 * `messages`, and the client marks breakpoints after the last tool, after each
 * system block, and after the last message block. A cache read therefore covers
 * a **prefix** of that sequence, and a partial read tells you where the match
 * stopped:
 *
 * - `cache read` covering only the tools, with the rest rewritten, means the
 *   `system` blocks differed. Hashing `system` and `tools` separately is what
 *   turns that inference into a measurement.
 * - Two requests with the same `system`+`tools` digest but different message
 *   counts are one agent's successive turns.
 * - Two requests with different digests are different agents — a subagent whose
 *   tool set was restricted, or a conversation with another persona — and their
 *   caches legitimately do not overlap.
 *
 * @module claude-server/shape
 */

import { createHash } from 'node:crypto';

/** Hex characters kept from each digest; 16 is 64 bits, far past what a
 * diagnostic grouping needs and short enough to read in a table. */
const DIGEST_CHARS = 16;

/**
 * A short stable digest of one value.
 *
 * `JSON.stringify` is the input because it is exactly what the relay forwards:
 * key order is preserved from the parsed body, and a body that parsed back to
 * the same JSON produces the same digest. Two requests that differ only in
 * whitespace are the same prompt, which is the behaviour wanted here.
 * @param value - anything JSON-serialisable.
 * @returns a 16-character hex digest, or undefined when the value is absent.
 */
function digestOf(value) {
  if (value === undefined) return undefined;
  return createHash('sha256').update(JSON.stringify(value)).digest('hex').slice(0, DIGEST_CHARS);
}

/**
 * The cache-relevant shape of a parsed request body.
 *
 * Returns undefined for a body that is not an object, which is how a
 * non-Messages request (or an unparsable one) is excluded from cache analysis
 * rather than being bucketed as a miss.
 * @param body - the parsed request body.
 * @returns the shape, or undefined when the body carries nothing to describe.
 */
export function cacheShape(body) {
  if (body === null || typeof body !== 'object') return undefined;

  const system = body.system;
  const tools = Array.isArray(body.tools) ? body.tools : undefined;
  const messages = Array.isArray(body.messages) ? body.messages : undefined;

  // Nothing cacheable was described at all: treat as absent rather than as an
  // empty prefix, so a probe or a health request does not pollute the analysis.
  if (system === undefined && tools === undefined && messages === undefined) return undefined;

  return {
    systemHash: digestOf(system),
    toolsHash: digestOf(tools),
    // Byte length, not token count: tokens are not available without a
    // tokenizer, and the point of this field is to see which agent a row
    // belongs to, which size does as well as tokens would.
    systemBytes: system === undefined ? 0 : JSON.stringify(system).length,
    toolsCount: tools === undefined ? 0 : tools.length,
    messagesCount: messages === undefined ? 0 : messages.length,
  };
}

/**
 * A label for the prefix a request caches under.
 *
 * Two requests share a cache identity only if both the tool set and the system
 * prompt match, because both sit inside the cacheable prefix. An agent with
 * restricted tools and a different persona therefore gets its own identity —
 * which is the distinction that separates "this agent's own cache is not being
 * reused" from "these are two agents and they were never going to share".
 * @param shape - a shape from {@link cacheShape}.
 * @returns a short identity string, or undefined when the shape is absent.
 */
export function cacheIdentityOf(shape) {
  if (shape === undefined) return undefined;
  return `${shape.toolsHash ?? 'notools'}:${shape.systemHash ?? 'nosystem'}`;
}
