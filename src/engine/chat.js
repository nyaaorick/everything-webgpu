/**
 * `engine.chat.completions.create()` — the WebLLM-shaped facade.
 *
 * The point of this file is that migrating off `@mlc-ai/web-llm` costs one
 * line. WebLLM is OpenAI-shaped, `buildParams()` already forwards `messages`,
 * `temperature`, `max_tokens`, `response_format` and `extra_body` untouched, and
 * everything this engine adds — the scheduler, multi-step decoding, the two
 * build patches, the three model sources — sits behind that same call rather
 * than beside it. So the facade is as thin as it can be: streamed chunks are
 * WebLLM's own objects, passed through untouched, and only the non-streaming
 * response is assembled here.
 *
 * `created` is therefore WebLLM's stable per-response value in milliseconds
 * (OpenAI uses seconds; WebLLM does not, and the drop-in target is WebLLM), and
 * the finish reasons are its own: `"stop" | "length" | "abort" | "tool_calls"`.
 *
 * `complete()` and `batch()` remain the direct API. They expose `cancelled` and
 * `preempted` as first-class outcomes, which the OpenAI shape has no room for —
 * both collapse to `finish_reason: "abort"` here, with the flags carried
 * alongside for a caller that cares which happened.
 */
import { ERROR, EngineError } from "./errors.js";

/** @param {import("./engine.js").ScheduledEngine} engine */
export function chatFacade(engine) {
  return {
    completions: {
      /**
       * @param {import("./engine.js").CompletionRequest & {
       *   stream?: boolean, stream_options?: {include_usage?: boolean} }} req
       * @returns {Promise<object | AsyncIterable<object>>} a completion, or a
       *   stream of chunks when `stream` is set — the same two shapes WebLLM
       *   returns, so `await`ing then `for await`ing works unchanged.
       */
      async create(req) {
        if (!Array.isArray(req?.messages) || req.messages.length === 0) {
          throw new EngineError(ERROR.BAD_REQUEST, "`messages` must be a non-empty array.");
        }
        return req.stream ? streamCompletion(engine, req) : oneCompletion(engine, req);
      },
    },
  };
}

const envelope = (engine, id, object) => ({
  id,
  object,
  created: Date.now(),
  model: engine.state.modelId,
});

async function oneCompletion(engine, req) {
  const id = req.id ?? crypto.randomUUID();
  const result = await engine.completeRaw(req);
  return {
    ...envelope(engine, id, "chat.completion"),
    choices: [
      {
        index: 0,
        // `content: null` beside tool_calls is WebLLM's own shape, not "".
        message: result.toolCalls
          ? { role: "assistant", content: null, tool_calls: result.toolCalls }
          : { role: "assistant", content: result.text },
        finish_reason: result.finishReason ?? "stop",
        logprobs: null,
      },
    ],
    usage: result.usage,
    ...(result.cancelled ? { cancelled: true } : {}),
    ...(result.preempted ? { preempted: true } : {}),
  };
}

/**
 * Bridges the raw chunk callback to an async iterator.
 *
 * Chunks pass through **verbatim**. WebLLM's are already compliant OpenAI
 * envelopes carrying `id`, `created`, `model`, `logprobs`,
 * `system_fingerprint` and the terminal `tool_calls`; the previous version
 * rebuilt them from a bare string and lost all of that.
 *
 * Chunks are queued rather than awaited, because the engine must not be made to
 * wait on a slow consumer: a stalled `for await` would hold a pool slot, and a
 * pool slot is the scarce resource the whole scheduler exists to allocate. The
 * queue is bounded in practice by `max_tokens`.
 */
async function streamCompletion(engine, req) {
  const id = req.id ?? crypto.randomUUID();

  /** @type {object[]} */
  const pending = [];
  let wake = null;
  /** @type {{result?: object, error?: unknown} | null} */
  let settled = null;
  const ping = () => {
    const w = wake;
    wake = null;
    w?.();
  };

  engine
    .completeRaw(req, (chunk) => {
      pending.push(chunk);
      ping();
    })
    .then(
      (result) => {
        settled = { result };
        ping();
      },
      (error) => {
        settled = { error };
        ping();
      },
    );

  return (async function* () {
    for (;;) {
      // Drain before checking `settled`, so the last chunks are never dropped
      // by a generation that finished while they sat in the queue.
      while (pending.length) yield pending.shift();
      if (settled) break;
      await new Promise((resolve) => (wake = resolve));
    }

    if (settled.error) throw settled.error;
    const result = settled.result;

    // Nothing is synthesized on the normal path: WebLLM emits its own terminal
    // finish_reason chunk, and its own usage chunk when `include_usage` is set.
    // An interrupted generation is the exception — the stream simply stops, so
    // a consumer would otherwise never learn why.
    if (result.cancelled || result.preempted) {
      yield {
        ...envelope(engine, id, "chat.completion.chunk"),
        choices: [{ index: 0, delta: {}, finish_reason: "abort" }],
        ...(result.cancelled ? { cancelled: true } : {}),
        ...(result.preempted ? { preempted: true } : {}),
      };
    }
  })();
}
