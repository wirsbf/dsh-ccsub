/**
 * The Host half of the browser sign-in conversation.
 *
 * `ctx.authorization` drives a flow and talks to the human through an
 * interaction object. In this profile no shipped surface renders that
 * interaction — the flow's `auth_url` notice, and its manual-code fallback
 * question, have nowhere to go. This module is the surface: it holds one
 * attempt's notices and pending question in memory and lets the settings card
 * poll for them, so the flow itself is still the seam's and the commit contract
 * is still the seam's.
 *
 * One attempt per key is the seam's own rule, so a single slot is enough and a
 * second concurrent attempt is refused by `begin()` rather than here.
 *
 * @module dsh-ccsub/auth/bridge
 */

/** How long a poll waits for something to happen before answering empty. */
const POLL_TIMEOUT_MS = 25_000;
/** How long a finished attempt's outcome stays readable by the card. */
const OUTCOME_TTL_MS = 5 * 60 * 1000;

/**
 * One in-flight sign-in, and the notices it has produced.
 *
 * @param authorization - the seam service to run the attempt through.
 * @param key - the credential record the attempt authorizes.
 * @param logger - where refusals worth surfacing are reported.
 */
export class LoginBridge {
  #authorization;
  #key;
  #logger;
  #state;
  #waiters;

  constructor(authorization, key, logger) {
    this.#authorization = authorization;
    this.#key = key;
    this.#logger = logger;
    this.#state = undefined;
    this.#waiters = new Set();
  }

  /** Wake every waiting poll: something about the attempt changed. */
  #notifyWaiters() {
    for (const wake of this.#waiters) wake();
    this.#waiters.clear();
  }

  /**
   * Wait until the attempt's state changes, or the poll window closes.
   * @param signal - caller cancellation.
   * @returns when state changed or the window elapsed.
   */
  async #waitForChange(signal) {
    if (signal?.aborted) return;
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.#waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, POLL_TIMEOUT_MS);
      this.#waiters.add(done);
      signal?.addEventListener('abort', done, { once: true });
    });
  }

  /**
   * The card-visible view of the current attempt.
   * @returns notices, the pending question, and the terminal outcome.
   */
  view() {
    const state = this.#state;
    if (state === undefined) return { active: false, notices: [], prompt: null, outcome: null };
    const { notices, prompt, outcome } = state;
    return {
      active: outcome === undefined,
      notices: notices.map((notice) => ({ ...notice })),
      prompt: prompt === undefined ? null : { id: prompt.id, kind: prompt.kind, message: prompt.message },
      outcome: outcome ?? null,
    };
  }

  /**
   * Answer the pending question.
   * @param id - the prompt being answered, so a stale answer is not applied.
   * @param value - the text or option id the human supplied.
   * @returns whether the answer matched a pending question.
   */
  answer(id, value) {
    const state = this.#state;
    if (state?.prompt === undefined || state.prompt.id !== id) return false;
    const resolve = state.prompt.resolve;
    state.prompt = undefined;
    this.#notifyWaiters();
    resolve(value);
    return true;
  }

  /**
   * Withdraw the attempt.
   *
   * Cancelling through the seam aborts the flow's own signal, which is what
   * withdraws whichever half of pi-ai's race is still outstanding.
   */
  cancel() {
    this.#authorization.cancel(this.#key);
    this.#notifyWaiters();
  }

  /**
   * Forget a settled outcome once it has had time to be read.
   */
  #expireLater() {
    const timer = setTimeout(() => {
      if (this.#state?.outcome !== undefined) {
        this.#state = undefined;
        this.#notifyWaiters();
      }
    }, OUTCOME_TTL_MS);
    timer.unref?.();
  }

  /**
   * Start one sign-in attempt and drive it to a terminal outcome.
   *
   * The returned promise settles when the attempt does; callers await it only
   * to know the outcome, and the card observes the same thing by polling.
   * @returns how the attempt ended.
   */
  async start() {
    const state = { notices: [], prompt: undefined, outcome: undefined };
    this.#state = state;
    let promptSeq = 0;

    const interaction = {
      notify: (notice) => {
        state.notices.push({ ...notice });
        // Bound the transcript so a long-lived attempt cannot grow without end.
        if (state.notices.length > 32) state.notices.splice(0, state.notices.length - 32);
        this.#notifyWaiters();
      },
      prompt: async (prompt) => {
        const id = `p${++promptSeq}`;
        state.notices.push({ message: prompt.message });
        const answer = await new Promise((resolve, reject) => {
          const onAbort = () => {
            state.prompt = undefined;
            reject(new Error('the sign-in attempt was withdrawn'));
          };
          prompt.signal?.addEventListener('abort', onAbort, { once: true });
          state.prompt = {
            id,
            kind: prompt.kind,
            message: prompt.message,
            resolve: (value) => {
              prompt.signal?.removeEventListener('abort', onAbort);
              resolve(value);
            },
          };
        });
        this.#notifyWaiters();
        return answer;
      },
    };

    try {
      const outcome = await this.#authorization.begin({
        key: this.#key,
        method: 'oauth',
        interaction,
      });
      state.outcome = { status: outcome.status ?? 'authorized', error: null };
      return state.outcome;
    } catch (error) {
      const message = String(error?.message ?? error);
      state.outcome = { status: 'failed', error: message, code: error?.code ?? null };
      this.#logger?.warn('dsh-ccsub: sign-in failed: %s', message);
      return state.outcome;
    } finally {
      state.prompt = undefined;
      this.#notifyWaiters();
      this.#expireLater();
    }
  }

  /**
   * Poll for a change, then answer the current view.
   * @param signal - caller cancellation.
   * @returns the current view.
   */
  async poll(signal) {
    await this.#waitForChange(signal);
    return this.view();
  }
}
