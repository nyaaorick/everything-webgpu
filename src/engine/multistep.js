/**
 * Multi-step decoding: N forward steps per GPU->CPU sync.
 *
 * Why this exists: decode here is not compute-bound, it is *sync*-bound. Firefox
 * resolves `onSubmittedWorkDone()` / `mapAsync()` only on a 100 ms poll tick
 * (AI.md, "The 10 tok/s ceiling"), and stock WebLLM needs exactly one sync per
 * token — it reads the sampled token id back to JS before it can build the next
 * step's input. One token per tick = 9.6 tok/s, of which ~7 ms is real compute.
 *
 * The fix is the one vLLM ships as `--num-scheduler-steps`: run K steps before
 * paying the per-batch cost once. What makes it possible here without touching
 * the compiled model is that WebLLM's sampling path is *already* on the GPU —
 * `softmax_with_temperature`, `argsort_probs` and `sample_with_top_p` hand back
 * an int32[1] device tensor, and `Tensor.copyFrom(Tensor)` is a device-to-device
 * copy. So the sampled id feeds straight back into `embed` without ever becoming
 * a JS number:
 *
 *   embed -> decode -> penalties -> softmax -> argsort -> sample -> embed -> ...
 *
 * Each step stages its id into its own CPU tensor, and the burst ends with
 * **one** `device.sync()`. tvmjs queues GPU->CPU copies into `pendingGPUToCPUCopy`
 * and only awaits them in `sync()`, so K readbacks still cost one tick.
 *
 * Two things follow from the 100 ms grid, and they are why `steps` is a dial:
 *
 *  - The win is quantized, not linear. A burst costs `ceil(K * perStepMs / 100)`
 *    ticks, so throughput is a sawtooth and the good values of K are the ones
 *    landing just under a boundary. On a 0.8B at ~7.3 ms/step that is K=13
 *    (~130 tok/s); K=14 already spills into a second tick and halves it.
 *  - The best K shrinks as the model grows, because `perStepMs` grows. A model
 *    at 25 ms/step wants K=4, not K=15.
 *
 * Cost of the trick: the sampler cannot see its own output mid-burst. Repetition
 * and presence/frequency penalties use the token history as it stood when the
 * burst started, and stop conditions are only checked after the readback, so a
 * burst can overshoot a stop token and must then be rewound. Both are the same
 * trade vLLM makes. Anything needing per-token CPU feedback (grammar-constrained
 * JSON, logprobs, a logit processor) falls back to single-step, where behaviour
 * is identical to stock WebLLM.
 *
 * The other cost is that all of this drives ~30 undocumented tvmjs internals. A
 * WebLLM upgrade that renames one does not break generation — it turns the fast
 * path off and takes the throughput with it, silently. `PIPELINE_CONTRACT` below
 * is that surface written down and checked against the live pipeline before the
 * first burst, so the failure announces itself instead of being measured months
 * later.
 */

/** vLLM's documented sweet spot, and the value this extension ships. */
export const DEFAULT_DECODE_STEPS = 15;

/**
 * Above this, the lookahead thrown away at a stop token outweighs the tick it
 * saves, and the transient logits/argsort buffers stop being free.
 */
export const MAX_DECODE_STEPS = 32;

export const clampSteps = (n) => Math.max(1, Math.min(MAX_DECODE_STEPS, Math.round(Number(n)) || 1));

// -------------------------------------------------- the pipeline contract ----

/**
 * Every tvmjs pipeline internal a burst drives, and how each must behave.
 *
 * None of these are documented, none are part of WebLLM's public surface, and
 * nothing upstream promises they will keep their names. The contract test checks
 * them against the *bundle* on every `npm test`; this checks them against the
 * *live object*, which is a different question — a member can survive in the
 * bundle and still not be on the pipeline handed to us, if upstream moves it to
 * a subclass, a different pipeline type, or behind a factory.
 *
 * Split three ways because presence alone is not the failure that hurts:
 *
 *  - **`calls`** must be callable. A rename here throws, which is the *good*
 *    case — it is loud.
 *  - **`numbers`** are read arithmetically or incremented in place. This is the
 *    silent one: `pipeline.filledKVCacheLength += 1` on a member that no longer
 *    exists creates a new property, nothing throws, and the KV cache accounting
 *    quietly drifts. A missing `contextWindowSize` makes `burstSize` NaN.
 *  - **`reads`** need only exist.
 *
 * `logitProcessor` is deliberately optional: `burstSize` tests it for
 * `undefined`, so absent is the normal case, not a broken one.
 *
 * The list is not maintained by hand — `webllm-contract.test.mjs` derives the
 * set this file actually reaches for from its own source and asserts it matches
 * this declaration exactly, so adding a `pipeline.newThing` without declaring it
 * fails the build.
 */
export const PIPELINE_CONTRACT = {
  calls: [
    "embed",
    "fKVCacheBeginForward",
    "fKVCacheEndForward",
    "fapplyLogitBias",
    "fapplyPenalty",
    "fargsortProbs",
    "fsampleWithTopP",
    "fsoftmaxWithTemperature",
    "getActiveKVStates",
    "invokeDecode",
    "processNextToken",
    "resetChat",
    "stopped",
  ],
  numbers: [
    "contextWindowSize",
    "curRoundDecodingTotalTime",
    "curRoundDecodingTotalTokens",
    "decodingTotalTime",
    "decodingTotalTokens",
    "filledKVCacheLength",
    "fullVocabSize",
    "slidingWindowSize",
  ],
  reads: [
    "appearedTokensFreq",
    "config",
    "device",
    "outputIds",
    "params",
    "sampleIndices",
    "sampleIndicesDevice",
    "topPDevice",
    "tvm",
  ],
  optional: ["logitProcessor"],
};

/**
 * What this pipeline is missing, as sentences a reader can act on.
 * Empty means a burst is safe to run.
 */
export function missingPipelineMembers(pipeline) {
  if (!pipeline || typeof pipeline !== "object") return ["the pipeline itself is not an object"];
  const missing = [];
  for (const name of PIPELINE_CONTRACT.calls) {
    if (typeof pipeline[name] !== "function") missing.push(`${name}() is not a function`);
  }
  for (const name of PIPELINE_CONTRACT.numbers) {
    if (typeof pipeline[name] !== "number") missing.push(`${name} is not a number`);
  }
  for (const name of PIPELINE_CONTRACT.reads) {
    if (pipeline[name] === undefined) missing.push(`${name} is missing`);
  }
  return missing;
}

/**
 * Replaces `engine.decode` with a burst-and-drain version.
 *
 * `decode` stays a one-token call — the caller's loop still checks
 * `pipeline.stopped()` between tokens and still emits one chunk per token — but
 * only one call in K actually touches the GPU. The rest drain a buffer.
 *
 * @param {object} engine an MLCEngine; in this project the one inside the worker
 * @param {object} [options]
 * @param {number} [options.steps] forward steps per sync; 1 disables the path
 * @param {(info: {steps: number, tokens: number, ms: number}) => void} [options.onBurst]
 * @param {(info: {missing: string[]}) => void} [options.onFallback] fired once
 *   per pipeline that fails the contract, before it is routed to stock decoding
 * @returns {{setSteps: (n: number) => void, readonly steps: number,
 *            readonly fallbacks: number}}
 */
export function installMultiStepDecoding(
  engine,
  { steps = DEFAULT_DECODE_STEPS, onBurst, onFallback } = {},
) {
  const config = { steps: clampSteps(steps), fallbacks: 0 };
  const lookahead = new WeakMap();
  const baseDecode = engine.decode.bind(engine);
  const basePrefill = engine.prefill.bind(engine);

  const stateFor = (pipeline) => {
    let state = lookahead.get(pipeline);
    if (!state) lookahead.set(pipeline, (state = { queue: [] }));
    return state;
  };

  /** Contract verdict per pipeline; the check runs once, the answer is reused. */
  const supported = new WeakMap();

  /**
   * Whether this pipeline may be burst, decided once and remembered.
   *
   * Checked at first decode rather than at install time because there is no
   * pipeline yet when this function runs — the engine gets one per `reload()`,
   * and hands it to us as an argument. So the guard lives at the first place a
   * pipeline is ever seen.
   *
   * Failing here means an upgrade moved something and multi-step decoding is
   * gone. Stock decoding still produces correct tokens, so the danger is not a
   * crash but silence: ~18.4 -> ~9.7 tok/s with nothing in the log to explain
   * it. Hence one loud report, and a `fallbacks` count the worker can surface.
   */
  const canBurst = (pipeline) => {
    const known = supported.get(pipeline);
    if (known !== undefined) return known;

    const missing = missingPipelineMembers(pipeline);
    supported.set(pipeline, missing.length === 0);
    if (missing.length > 0) {
      config.fallbacks += 1;
      console.error(
        "[everything-webgpu] multi-step decoding disabled — falling back to stock " +
          "single-step decode. Generation stays correct, throughput roughly halves.\n" +
          `  The pipeline is missing ${missing.length} of the internals a burst drives:\n` +
          missing.map((line) => `    - ${line}`).join("\n") +
          "\n  This is what a WebLLM upgrade looks like from here. `npm test` " +
          "(webllm-contract) says whether the names are gone from the bundle too.",
      );
      onFallback?.({ missing });
    }
    return missing.length === 0;
  };

  // A round can end with tokens still buffered — a stop token mid-burst, or an
  // interrupt that breaks the caller's loop. Those tokens are already in the KV
  // cache, so they must come back out before the next round reuses it.
  engine.prefill = async (input, pipeline, chatConfig, genConfig) => {
    discardLookahead(pipeline, stateFor(pipeline));
    return basePrefill(input, pipeline, chatConfig, genConfig);
  };

  engine.decode = async (pipeline, genConfig) => {
    const state = stateFor(pipeline);

    if (state.queue.length === 0) {
      // Before the first burst on this pipeline, not before every one: the
      // verdict is cached, so a healthy pipeline pays one property scan for the
      // whole conversation.
      if (!canBurst(pipeline)) return baseDecode(pipeline, genConfig);

      const burst = burstSize(pipeline, genConfig, config.steps);
      if (burst <= 1) return baseDecode(pipeline, genConfig);

      const probe = {};
      const tstart = performance.now();
      state.queue = await sampleBurst(pipeline, genConfig, burst, probe);
      const ms = performance.now() - tstart;

      // One burst is one wall-clock cost; its tokens are counted as they drain,
      // so a rewound overshoot never inflates the reported rate.
      pipeline.decodingTotalTime += ms / 1e3;
      pipeline.curRoundDecodingTotalTime += ms / 1e3;
      onBurst?.({ steps: burst, tokens: state.queue.length, ms, ...probe });
    }

    const token = state.queue.shift();
    pipeline.decodingTotalTokens += 1;
    pipeline.curRoundDecodingTotalTokens += 1;
    pipeline.processNextToken(token, genConfig);

    // The burst ran past a stop token; nothing after it was ever emitted.
    if (pipeline.stopped() && state.queue.length > 0) discardLookahead(pipeline, state);
  };

  return {
    setSteps: (n) => void (config.steps = clampSteps(n)),
    get steps() {
      return config.steps;
    },
    /** Pipelines that failed the contract. Non-zero means the fast path is off. */
    get fallbacks() {
      return config.fallbacks;
    },
  };
}

// ------------------------------------------------------------- burst size ---

/**
 * How many steps may run before the next stop condition *has* to be checked.
 *
 * `max_tokens` and the context window are countable, so they are clamped rather
 * than overshot — which leaves stop tokens as the only reason a burst is ever
 * rewound. Returns 1 when multi-step cannot be used at all, routing the caller
 * to stock single-step decoding.
 */
export function burstSize(pipeline, genConfig, steps) {
  if (steps <= 1) return 1;

  // Per-token CPU feedback: the next step's logits depend on a JS-side decision
  // about this step's token, so there is nothing to overlap.
  const format = genConfig?.response_format?.type;
  if (format === "json_object" || format === "grammar" || format === "structural_tag") return 1;
  if (genConfig?.logprobs) return 1;
  if (pipeline.logitProcessor !== undefined) return 1;

  const maxTokens = genConfig?.max_tokens;
  const untilMax = maxTokens ? maxTokens - pipeline.outputIds.length : Infinity;
  const untilContextEnd =
    pipeline.slidingWindowSize === -1
      ? pipeline.contextWindowSize - pipeline.filledKVCacheLength
      : Infinity;

  return Math.max(1, Math.min(steps, untilMax, untilContextEnd));
}

// ----------------------------------------------------------------- burst ----

/**
 * Runs `steps` forward+sample steps with no GPU->CPU sync between them, then
 * pays exactly one.
 *
 * @returns {Promise<number[]>} the sampled token ids, in order
 */
async function sampleBurst(pipeline, genConfig, steps, out) {
  const { tvm, device } = pipeline;
  let probe = null;
  const vocab = pipeline.fullVocabSize;
  const sampling = resolveSampling(pipeline, genConfig);

  tvm.beginScope();
  let temperatures;
  let bias;
  let penalty;
  /** The last committed token, which seeds step 0. Owned here, not by a scope. */
  let seedTokens;
  try {
    temperatures = tvm.detachFromCurrentScope(
      tvm.empty([1], "float32", device).copyFrom([Math.max(1e-6, sampling.temperature)]),
    );
    bias = makeLogitBias(pipeline, sampling);
    penalty = makePenalty(pipeline, sampling);
    // top_p lives in a tensor the pipeline owns and reuses, set up exactly as
    // `sampleTokenFromLogits` does. It is constant for the whole burst.
    const topPHost = new Float32Array(pipeline.topPDevice.shape[0]).fill(-1);
    const topP = Math.max(sampling.top_p, 1e-5);
    pipeline.sampleIndices.forEach((row) => (topPHost[row] = topP));
    pipeline.topPDevice.copyFrom(topPHost);
    seedTokens = tvm.detachFromCurrentScope(
      tvm.empty([1], "int32", device).copyFrom([pipeline.outputIds[pipeline.outputIds.length - 1]]),
    );
  } finally {
    tvm.endScope();
  }
  let tokens = seedTokens;

  /**
   * Sampled ids stay on the device for the whole loop; the host copies happen
   * after it, never interleaved with compute.
   *
   * The order is load-bearing. `flushCommands()` nulls tvmjs's
   * `pendingGPUToCPUCopy` whenever it submits an encoder, and every GPU->CPU
   * copy calls it. Interleaving copies with compute therefore made each step
   * discard the previous step's pending readback, leaving `device.sync()`
   * awaiting only the last one — correct in practice only because the
   * `mapAsync` promises happen to resolve in FIFO order. Doing all the copies
   * after the loop means the first flushes and starts the chain while the rest
   * find no pending encoder, so the chain accumulates intact.
   */
  const sampledIds = [];
  /** One CPU int32[1] per step. All of their reads land on the same poll tick. */
  const staged = [];

  // The decisive probe. The K-step loop below contains no `await`, so it is one
  // synchronous JS turn: everything it costs is content-process CPU — command
  // encoding, `createBindGroup`, IPC to the GPU process. The `await` after it is
  // everything else: GPU execution plus the wait for the next 100 ms poll tick.
  // Splitting the two says which one the budget actually goes to.
  const gpuCtx = tvm.lib?.webGPUContext;
  const dispatchesBefore = gpuCtx?.shaderSubmitCounter ?? 0;
  const flushesBefore = countFlushes(gpuCtx);
  let forwardDispatches = 0;
  const tEncodeStart = performance.now();

  try {
    for (let step = 0; step < steps; step++) {
      tvm.beginScope();
      const stepStart = gpuCtx?.shaderSubmitCounter ?? 0;
      try {
        // `tokens` is owned by `sampledIds` (or is the seed), not by this scope.
        const embeddings = pipeline.embed(tokens, pipeline.params);
        const batched = embeddings.view([1].concat(embeddings.shape));

        const states = pipeline.getActiveKVStates();
        const seqIds = tvm.makeShapeTuple([0]);
        const inputLen = tvm.makeShapeTuple([1]);
        for (const state of states) pipeline.fKVCacheBeginForward(state, seqIds, inputLen);
        const forwarded = pipeline.invokeDecode(batched);
        for (let i = states.length - 1; i >= 0; i--) pipeline.fKVCacheEndForward(states[i]);
        pipeline.filledKVCacheLength += 1;

        // Split the launch count at the forward/sample boundary. The sampling
        // tail is `argsort_probs` over the full vocab (248k here), which is a
        // multi-pass sort and belongs to the runtime, not the model — so it is
        // worth knowing how much of the per-token kernel budget it owns.
        forwardDispatches += (gpuCtx?.shaderSubmitCounter ?? 0) - stepStart;

        const logits = forwarded.get(0);
        if (bias) {
          pipeline.fapplyLogitBias(logits.view([1, vocab]), bias.pos2seqIds, bias.tokenIds, bias.values);
        }
        if (penalty) {
          pipeline.fapplyPenalty(
            logits.view([1, vocab]),
            penalty.seqIds,
            penalty.pos2seqIds,
            penalty.tokenIds,
            penalty.counts,
            penalty.penalties,
          );
        }

        const probs = pipeline
          .fsoftmaxWithTemperature(logits.view([1, 1, vocab]), temperatures)
          .view([1, vocab]);
        const sorted = pipeline.fargsortProbs(probs);
        const sampled = pipeline.fsampleWithTopP(
          sorted.get(0),
          sorted.get(1),
          tvm.uniform([1], 0, 1, device),
          pipeline.sampleIndicesDevice,
          pipeline.topPDevice,
        );

        tokens = tvm.detachFromCurrentScope(sampled);
        sampledIds.push(tokens);
      } finally {
        tvm.endScope();
      }
    }

    // Every readback together, after all compute: one flush, one intact chain.
    tvm.beginScope();
    try {
      for (const id of sampledIds) {
        staged.push(tvm.detachFromCurrentScope(tvm.empty([1], "int32", tvm.cpu()).copyFrom(id)));
      }
    } finally {
      tvm.endScope();
    }

    // Encoding the copies is still CPU work, so the boundary sits after them.
    const tEncoded = performance.now();

    // The one sync the whole burst pays for.
    await device.sync();

    probe = {
      encodeMs: tEncoded - tEncodeStart,
      syncMs: performance.now() - tEncoded,
      dispatches: (gpuCtx?.shaderSubmitCounter ?? 0) - dispatchesBefore,
      forwardDispatches,
      flushes: countFlushes(gpuCtx) - flushesBefore,
    };
    return staged.map((host) => host.toArray()[0]);
  } finally {
    if (probe) Object.assign(out, probe);
    for (const host of staged) host.dispose();
    for (const id of sampledIds) id.dispose();
    seedTokens?.dispose();
    temperatures.dispose();
    disposeAll(bias);
    disposeAll(penalty);
  }
}

/**
 * Kernel launches per `flushCommands()`, which decides whether batching tvmjs's
 * per-kernel compute passes into one pass is worth anything.
 *
 * `flushCommands()` submits the pending encoder — so it would also close a
 * shared pass — and it fires from `deviceFreeDataSpace`, the buffer copies and
 * `sync`. If TVM frees an intermediate between every op then flushes ≈ kernels,
 * the pass stream is already chopped up, and there is nothing to merge. tvmjs
 * keeps no counter of its own, so wrap the method once per context.
 */
function countFlushes(gpuCtx) {
  if (!gpuCtx) return 0;
  if (gpuCtx.__ewgpuFlushCount === undefined) {
    const base = gpuCtx.flushCommands.bind(gpuCtx);
    gpuCtx.__ewgpuFlushCount = 0;
    gpuCtx.flushCommands = () => {
      gpuCtx.__ewgpuFlushCount += 1;
      base();
    };
  }
  return gpuCtx.__ewgpuFlushCount;
}

// ---------------------------------------------------------------- rewind ----

/**
 * Drops un-emitted lookahead and takes it back out of the KV cache.
 *
 * `kv_state_popn` is the clean path. If the runtime has not registered it the
 * cache cannot be trimmed, so it is thrown away instead: the next round pays a
 * full re-prefill (one sync, not one per token) rather than attending over
 * tokens the caller never saw.
 */
function discardLookahead(pipeline, state) {
  const n = state.queue.length;
  state.queue = [];
  if (n === 0) return;

  const { tvm } = pipeline;
  try {
    const popn = getPopN(pipeline);
    if (popn) {
      tvm.beginScope();
      try {
        for (const kvState of pipeline.getActiveKVStates()) {
          popn(kvState, tvm.scalar(0, "int64"), tvm.scalar(n, "int32"));
        }
      } finally {
        tvm.endScope();
      }
      pipeline.filledKVCacheLength -= n;
      return;
    }
  } catch {
    // Fall through: a trim that threw is handled the same as no trim at all.
  }
  pipeline.resetChat(/* keepStats= */ true);
}

const popNCache = new WeakMap();

function getPopN(pipeline) {
  if (popNCache.has(pipeline)) return popNCache.get(pipeline);
  let popn = null;
  const { tvm } = pipeline;
  tvm.beginScope();
  try {
    popn = tvm.detachFromCurrentScope(tvm.getGlobalFunc("vm.builtin.kv_state_popn"));
  } catch {
    popn = null;
  } finally {
    tvm.endScope();
  }
  popNCache.set(pipeline, popn);
  return popn;
}

// ------------------------------------------------------- sampling inputs ----

/**
 * The subset of `sampleTokenFromLogits`'s config resolution a burst can honour,
 * in the same precedence order: the request overrides `mlc-chat-config.json`.
 */
function resolveSampling(pipeline, genConfig) {
  const has = (v) => v !== undefined && v !== null;
  const pick = (key, fallback) => (has(genConfig?.[key]) ? genConfig[key] : fallback);
  return {
    temperature: pick("temperature", pipeline.config.temperature),
    top_p: pick("top_p", pipeline.config.top_p) ?? 1,
    repetition_penalty: pick("repetition_penalty", pipeline.config.repetition_penalty),
    frequency_penalty: pick("frequency_penalty", pipeline.config.frequency_penalty) ?? 0,
    presence_penalty: pick("presence_penalty", pipeline.config.presence_penalty) ?? 0,
    logit_bias: pick("logit_bias", undefined),
  };
}

/** Static for the whole request, so it is uploaded once and reused every step. */
function makeLogitBias(pipeline, { logit_bias }) {
  const ids = Object.keys(logit_bias ?? {});
  if (ids.length === 0) return null;
  const { tvm, device } = pipeline;
  const int32 = (values) =>
    tvm.detachFromCurrentScope(tvm.empty([values.length], "int32", device).copyFrom(values));
  return {
    pos2seqIds: int32(new Int32Array(ids.length)),
    tokenIds: int32(Int32Array.from(ids, (id) => parseInt(id, 10))),
    values: tvm.detachFromCurrentScope(
      tvm.empty([ids.length], "float32", device).copyFrom(Float32Array.from(ids, (id) => logit_bias[id])),
    ),
  };
}

/**
 * Frozen token history for the burst.
 *
 * This is the one place multi-step is not equivalent to single-step: tokens
 * sampled *within* a burst are not penalised against each other, because their
 * ids are still on the GPU. At K=15 the penalty state is at most 15 tokens
 * stale. Anything that cannot tolerate that should run with `decodeSteps: 1`.
 */
function makePenalty(pipeline, { repetition_penalty, frequency_penalty, presence_penalty }) {
  const active = frequency_penalty !== 0 || presence_penalty !== 0 || (repetition_penalty ?? 1) !== 1;
  if (!active) return null;

  const appeared = [...pipeline.appearedTokensFreq.keys()];
  if (appeared.length === 0) return null;
  const freqs = [...pipeline.appearedTokensFreq.values()];

  const { tvm, device } = pipeline;
  const int32 = (values) =>
    tvm.detachFromCurrentScope(tvm.empty([values.length], "int32", device).copyFrom(values));
  return {
    seqIds: int32(new Int32Array(1)),
    pos2seqIds: int32(new Int32Array(appeared.length)),
    tokenIds: int32(Int32Array.from(appeared)),
    counts: int32(Int32Array.from(freqs)),
    penalties: tvm.detachFromCurrentScope(
      tvm
        .empty([1, 3], "float32", device)
        .copyFrom(new Float32Array([presence_penalty, frequency_penalty, repetition_penalty ?? 1])),
    ),
  };
}

function disposeAll(inputs) {
  if (!inputs) return;
  for (const tensor of Object.values(inputs)) tensor.dispose();
}
