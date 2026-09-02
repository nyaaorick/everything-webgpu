/**
 * The three shapes of work, as one call each.
 *
 * `complete()` and `chat.completions.create()` can already express all of this.
 * What they cannot do is stop a caller getting the *scheduling* wrong, and the
 * scheduling is the part that is easy to get wrong and invisible when you do:
 * ghost text that lags a keystroke behind, a conversation whose turns fight
 * each other for engines, a one-shot that superseded the last one because it
 * reused a session key. Those are the bugs AI.md's "Getting these wrong" table
 * is made of, and every row of it is a scheduling mistake rather than a
 * generation one.
 *
 * So these are not wrappers that save typing. Each one is a *policy*:
 *
 *   ask()          one-shot, its own task, no session, nothing to supersede
 *   conversation()  one stable task for every turn, history the caller can see
 *   ghostText()     debounce + one session key + interactive + drop-if-stale
 *
 * ## What they deliberately do not do
 *
 * **They author no prompts.** `ask()` and `conversation()` carry the caller's
 * own text through as a message; `ghostText()` *requires* a `prompt` function
 * and has no default for it. This is AI.md's load-bearing rule, and the reason
 * is not purity: prompts are model-specific, and switching this project's own
 * build from `Qwen3.5-0.8B` to `Qwen3.8-2B-Distill` changed the conversation
 * template and made every reply open with a `<think>` block. A prompt that
 * lives in the caller survives that. One baked in here would have to be
 * rewritten and re-shipped to every caller.
 */
import { ERROR, EngineError } from "./errors.js";
import { PRIORITY } from "./constants.js";

/**
 * A single question, with nothing kept afterwards.
 *
 * Its own task and no session, so two `ask()`s in flight never supersede each
 * other and never queue behind one another for the same engine — which is what
 * would happen if this shared a session key with anything else.
 *
 * @param {import("./engine.js").ScheduledEngine} engine
 * @param {string | Array<{role: string, content: string}>} input
 * @param {object} [opts] anything `complete()` takes; `onDelta` to stream
 * @returns {Promise<string>} the reply text
 */
export async function ask(engine, input, { onDelta, ...opts } = {}) {
  const messages = toMessages(input, "ask");
  const { text } = await engine.complete(
    { priority: PRIORITY.NORMAL, ...opts, messages },
    onDelta,
  );
  return text;
}

/**
 * A multi-turn conversation that remembers its own history.
 *
 * Two things this gets right that hand-rolled history usually does not:
 *
 * **One task for the whole conversation.** Every turn carries the same `task`,
 * so a conversation holds at most one engine and a long reply can never occupy
 * the pool while another conversation waits. Turns within it are serialised,
 * which is what a conversation means anyway.
 *
 * **A bounded history, by default.** There is no cross-turn KV reuse on this
 * stack (AI.md: every turn re-prefills the whole history at ~5.27 ms/token), so
 * an unbounded conversation gets quadratically slower and a turn near the 4096
 * limit waits ~22 s for its first token. `keep` bounds it. Set `keep: Infinity`
 * to opt out, having read that sentence.
 *
 * @param {import("./engine.js").ScheduledEngine} engine
 * @param {object} [opts]
 * @param {string} [opts.system] a system message, prepended and never trimmed
 * @param {number} [opts.keep] how many *exchanges* of history to carry
 * @param {string} [opts.task] defaults to a fresh id
 */
export function conversation(engine, { system, keep = 12, task, ...defaults } = {}) {
  if (typeof keep !== "number" || (keep < 1 && keep !== Infinity)) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `conversation({ keep }) must be a positive number of exchanges, or Infinity. Got ${JSON.stringify(keep)}.`,
      { keep },
    );
  }

  const id = task ?? `conversation-${++counter}`;
  /** User/assistant messages only; `system` is held apart so trimming cannot eat it. */
  let turns = [];
  /** Turns are serialised: overlapping ones would interleave history. */
  let inFlight = Promise.resolve();

  async function turn(content, onDelta) {
    const sent = [...api.messages, { role: "user", content }];
    const { text, finishReason } = await engine.complete(
      { ...defaults, task: id, priority: defaults.priority ?? PRIORITY.NORMAL, messages: sent },
      onDelta,
    );
    // Appended only on success: a failed turn must not leave the history
    // holding a question the model never answered.
    turns.push({ role: "user", content }, { role: "assistant", content: text });
    trim();
    return { text, finishReason };
  }

  const api = {
    /** The messages as they would be sent, including the system message. */
    get messages() {
      return system ? [{ role: "system", content: system }, ...turns] : [...turns];
    },

    /** Exchanges currently retained. */
    get length() {
      return Math.ceil(turns.length / 2);
    },

    /**
     * Say something and get the reply, with the exchange appended to history.
     *
     * Serialised against the previous turn: a conversation whose turns
     * overlapped would interleave history and produce replies to the wrong
     * question.
     *
     * @param {string} content
     * @param {(delta: string) => void} [onDelta]
     */
    async say(content, onDelta) {
      if (typeof content !== "string" || content.length === 0) {
        throw new EngineError(ERROR.BAD_REQUEST, "conversation.say() needs a non-empty string.", {
          received: typeof content,
        });
      }
      const run = inFlight.then(() => turn(content, onDelta));
      // The chain must survive a failed turn: `.catch` here keeps the *queue*
      // moving without swallowing the rejection the caller is awaiting.
      inFlight = run.catch(() => {});
      return run;
    },

    /** Forget the history. The system message and settings survive. */
    reset() {
      turns = [];
      return api;
    },

    /** Drop the history in, e.g. when restoring a saved conversation. */
    restore(messages) {
      turns = messages.filter((m) => m.role !== "system").map((m) => ({ ...m }));
      trim();
      return api;
    },
  };

  function trim() {
    if (keep === Infinity) return;
    const max = keep * 2;
    if (turns.length > max) turns = turns.slice(turns.length - max);
  }

  return api;
}

/**
 * Ghost text: the scheduling discipline, with the prompt left to the caller.
 *
 * Every part of this exists because of a specific way ghost text goes wrong:
 *
 * | | |
 * | --- | --- |
 * | one stable `session` | a fresh id per keystroke makes every stale request still run — AI.md's first "getting these wrong" row |
 * | `interactive` priority | it is the one band that may preempt work that opted in |
 * | debounce | a request per keystroke queues faster than the GPU drains |
 * | short `max_tokens` | ghost text is a few words; paying for more is pure latency |
 * | resolves `null` when stale | so a superseded suggestion **cannot** be rendered by mistake |
 *
 * That last one is the difference between this and a wrapper. The engine
 * already supersedes stale requests; what a caller still has to remember is not
 * to paint the answer that comes back. Returning `null` removes the choice.
 *
 * @param {import("./engine.js").ScheduledEngine} engine
 * @param {object} opts
 * @param {(context: any) => string | Array<object>} opts.prompt **required** —
 *   builds the messages. Never defaulted: see the module header.
 * @param {number} [opts.debounceMs]
 * @param {number} [opts.maxTokens]
 * @param {string} [opts.session]
 */
export function ghostText(engine, { prompt, debounceMs = 120, maxTokens = 24, session, ...defaults } = {}) {
  if (typeof prompt !== "function") {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      "ghostText({ prompt }) needs a function that turns your editor context into messages. " +
        "It has no default on purpose: prompts are model-specific and belong to whoever owns the feature.",
      { received: typeof prompt },
    );
  }

  const key = session ?? `ghost-${++counter}`;
  let generation = 0;
  let timer = null;
  /**
   * Settles the debounce wait of the call currently holding the timer.
   *
   * Without this, cancelling that timer left its `await` with nothing to
   * resolve it — every superseded keystroke leaked a promise that never
   * settled, and `Promise.all` over a burst of them hung forever. A superseded
   * waiter has to be *woken and told it lost*, not merely disarmed.
   */
  let wake = null;

  const stopWaiting = (quiet) => {
    clearTimeout(timer);
    timer = null;
    const settle = wake;
    wake = null;
    settle?.(quiet);
  };

  const api = {
    /**
     * Ask for a suggestion. Debounced, superseding, and `null` when stale.
     *
     * @param {any} context whatever `prompt` takes
     * @returns {Promise<string | null>} `null` if superseded or cancelled
     */
    async suggest(context) {
      const mine = ++generation;

      if (debounceMs > 0) {
        stopWaiting(false); // the previous waiter loses, and is told so
        const quiet = await new Promise((resolve) => {
          wake = resolve;
          timer = setTimeout(() => stopWaiting(true), debounceMs);
        });
        // A newer keystroke landed while waiting; that request owns the session.
        if (!quiet || mine !== generation) return null;
      }

      const messages = toMessages(prompt(context), "ghostText's prompt()");
      const result = await engine.complete({
        max_tokens: maxTokens,
        ...defaults,
        messages,
        session: key,
        priority: PRIORITY.INTERACTIVE,
      });

      // Two ways to be stale, and both must return null: the engine superseded
      // us (`cancelled`), or a newer suggest() started while we generated.
      if (result.cancelled || result.preempted || mine !== generation) return null;
      return result.text;
    },

    /** On blur, or on accept. Cancels in flight and invalidates anything pending. */
    cancel() {
      generation += 1;
      stopWaiting(false);
      return engine.cancel(key);
    },
  };

  return api;
}

let counter = 0;

/** The one place caller text becomes a message, so no verb invents its own shape. */
function toMessages(input, who) {
  if (typeof input === "string") {
    if (input.length === 0) {
      throw new EngineError(ERROR.BAD_REQUEST, `${who} was given an empty string.`, { who });
    }
    return [{ role: "user", content: input }];
  }
  if (Array.isArray(input) && input.length > 0 && input.every((m) => m?.role && m?.content !== undefined)) {
    return input;
  }
  throw new EngineError(
    ERROR.BAD_REQUEST,
    `${who} needs a string, or a non-empty array of { role, content } messages.`,
    { who, received: Array.isArray(input) ? "array" : typeof input },
  );
}
