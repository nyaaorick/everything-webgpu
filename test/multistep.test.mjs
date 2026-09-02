/**
 * Multi-step decoding without a GPU.
 *
 * The fake tvm below is deliberately strict about the two properties the whole
 * trick rests on, because both fail silently on real hardware:
 *
 *  - a staged readback cannot be read before `device.sync()` — that is what
 *    makes "K tokens, one sync" different from "K syncs";
 *  - every tensor a burst allocates must be disposed, since a burst allocates
 *    K times what a single step does.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import {
  PIPELINE_CONTRACT,
  burstSize,
  clampSteps,
  installMultiStepDecoding,
  missingPipelineMembers,
} from "../src/engine/multistep.js";

// ------------------------------------------------------------------ fakes ---

function fakeTvm(device) {
  const scopes = [];
  const live = new Set();

  const tensor = (data, { owned = false } = {}) => {
    const t = {
      data: Array.from(data),
      shape: [data.length],
      owned,
      disposed: false,
      view(shape) {
        return { ...t, shape, view: t.view, dispose() {}, toArray: t.toArray };
      },
      toArray() {
        if (t.host && device.syncCount === t.stagedAt) {
          throw new Error("read a staged readback before device.sync()");
        }
        return t.data;
      },
      copyFrom(src) {
        t.data = Array.isArray(src) || ArrayBuffer.isView(src) ? Array.from(src) : Array.from(src.data);
        if (t.host) {
          device.ops.push("readback");
          t.stagedAt = device.syncCount;
        }
        return t;
      },
      dispose() {
        t.disposed = true;
        live.delete(t);
      },
    };
    if (!owned) live.add(t);
    tvm.attachToCurrentScope(t);
    return t;
  };

  const tvm = {
    live,
    tensor,
    beginScope: () => scopes.push([]),
    endScope: () => scopes.pop().forEach((t) => t.dispose()),
    attachToCurrentScope: (t) => void scopes.at(-1)?.push(t),
    detachFromCurrentScope(t) {
      const scope = scopes.at(-1);
      if (scope) scope.splice(scope.indexOf(t), 1);
      return t;
    },
    empty: (shape) => tensor(new Array(shape.reduce((a, b) => a * b, 1)).fill(0)),
    uniform: () => tensor([0.5]),
    cpu: () => ({ host: true }),
    makeShapeTuple: (shape) => shape,
    scalar: (value) => value,
    getGlobalFunc(name) {
      if (name !== "vm.builtin.kv_state_popn" || !device.hasPopN) {
        throw new Error(`Cannot find global function ${name}`);
      }
      const fn = (_state, _seq, n) => device.popped.push(n);
      tvm.attachToCurrentScope({ dispose() {} });
      return fn;
    },
  };

  // `empty` on the cpu device produces a staged readback, which must not be
  // readable until sync. Wrap it here so callers keep the real signature.
  const baseEmpty = tvm.empty;
  tvm.empty = (shape, dtype, dev) => {
    const t = baseEmpty(shape, dtype, dev);
    if (dev?.host) {
      t.host = true;
      t.stagedAt = device.syncCount;
    }
    return t;
  };
  return tvm;
}

function fakePipeline({ script, stopTokens = [], hasPopN = true } = {}) {
  let cursor = 0;
  const device = {
    syncCount: 0,
    popped: [],
    hasPopN,
    /** Ordered log of "embed" / "readback" so tests can assert they never interleave. */
    ops: [],
    async sync() {
      device.syncCount += 1;
    },
  };
  const tvm = fakeTvm(device);

  const owned = (data) => {
    tvm.beginScope();
    const t = tvm.tensor(data, { owned: true });
    tvm.detachFromCurrentScope(t);
    tvm.endScope();
    return t;
  };

  const pipeline = {
    tvm,
    device,
    params: {},
    fullVocabSize: 32,
    config: { temperature: 0.7, top_p: 0.95, repetition_penalty: 1, frequency_penalty: 0, presence_penalty: 0 },
    contextWindowSize: 4096,
    slidingWindowSize: -1,
    filledKVCacheLength: 4,
    outputIds: [7],
    appearedTokensFreq: new Map([[7, 1]]),
    stopTokens,
    stopTriggered: false,
    sampleIndices: new Int32Array([0]),
    sampleIndicesDevice: owned([0]),
    topPDevice: owned([0]),
    decodingTotalTime: 0,
    decodingTotalTokens: 0,
    curRoundDecodingTotalTime: 0,
    curRoundDecodingTotalTokens: 0,

    /** What each step was actually fed — asserts the chain stays on the GPU. */
    fed: [],
    resetCalls: 0,

    embed(tokens) {
      pipeline.fed.push(tokens.data[0]);
      device.ops.push("embed");
      return tvm.tensor([0, 0]);
    },
    getActiveKVStates: () => [{ kv: true }],
    fKVCacheBeginForward() {},
    fKVCacheEndForward() {},
    invokeDecode: () => ({ get: () => tvm.tensor(new Array(32).fill(0)) }),
    fapplyLogitBias() {},
    fapplyPenalty() {},
    fsoftmaxWithTemperature: () => tvm.tensor(new Array(32).fill(0)),
    fargsortProbs: () => ({ get: () => tvm.tensor(new Array(32).fill(0)) }),
    fsampleWithTopP: () => tvm.tensor([script[cursor++]]),

    stopped: () => pipeline.stopTriggered,
    resetChat() {
      pipeline.resetCalls += 1;
      pipeline.filledKVCacheLength = 0;
    },
    processNextToken(token, genConfig) {
      if (pipeline.stopTokens.includes(token)) {
        pipeline.stopTriggered = true;
        return;
      }
      pipeline.outputIds.push(token);
      if (genConfig?.max_tokens && pipeline.outputIds.length >= genConfig.max_tokens) {
        pipeline.stopTriggered = true;
      }
    },
  };
  return pipeline;
}

/** Stands in for the MLCEngine whose `decode`/`prefill` get wrapped. */
function fakeEngine() {
  const calls = { decode: 0, prefill: 0 };
  return {
    calls,
    async decode(pipeline, genConfig) {
      calls.decode += 1;
      pipeline.filledKVCacheLength += 1;
      pipeline.processNextToken(-1, genConfig);
    },
    async prefill() {
      calls.prefill += 1;
    },
  };
}

/** Drives the caller's loop: decode until the pipeline says stop. */
async function drain(engine, pipeline, genConfig, limit = 64) {
  const seen = [];
  for (let i = 0; i < limit && !pipeline.stopped(); i++) {
    const before = pipeline.outputIds.length;
    await engine.decode(pipeline, genConfig);
    if (pipeline.outputIds.length > before) seen.push(pipeline.outputIds.at(-1));
  }
  return seen;
}

const assertNoLeaks = (pipeline) =>
  assert.equal(pipeline.tvm.live.size, 0, "every tensor a burst allocates must be disposed");

// ------------------------------------------------------------------ tests ---

test("15 tokens cost one GPU sync, not 15", async () => {
  // This is the entire point: the 100 ms poll tick is paid once per burst.
  const script = Array.from({ length: 15 }, (_, i) => 100 + i);
  const pipeline = fakePipeline({ script });
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 15 });

  const seen = await drain(engine, pipeline, { max_tokens: 16 });

  assert.deepEqual(seen, script, "tokens surface one at a time, in sampling order");
  assert.equal(pipeline.device.syncCount, 1, "one sync for the whole burst");
  assert.equal(engine.calls.decode, 0, "never fell back to single-step");
  assertNoLeaks(pipeline);
});

test("all compute is encoded before any readback is", async () => {
  // tvmjs's `flushCommands()` nulls its pending-readback chain whenever it
  // submits an encoder, and a GPU->CPU copy triggers it. Interleaving copies
  // with compute therefore drops every readback but the last from what
  // `device.sync()` waits on. Keeping the two phases separate is what makes the
  // single sync actually cover all K tokens.
  const pipeline = fakePipeline({ script: [1, 2, 3, 4, 5, 6] });
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 6 });

  await engine.decode(pipeline, {});

  const { ops } = pipeline.device;
  assert.equal(ops.filter((o) => o === "embed").length, 6);
  assert.equal(ops.filter((o) => o === "readback").length, 6);
  assert.ok(
    ops.lastIndexOf("embed") < ops.indexOf("readback"),
    `compute and readback interleaved: ${ops.join(",")}`,
  );
  assertNoLeaks(pipeline);
});

test("each step is fed the previous step's token without a readback", async () => {
  const script = [11, 22, 33, 44];
  const pipeline = fakePipeline({ script });
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 4 });

  await drain(engine, pipeline, { max_tokens: 5 });

  // Step 0 gets the last committed token; every later step gets the id sampled
  // on the GPU one step earlier, which is what removes the per-token sync.
  assert.deepEqual(pipeline.fed, [7, 11, 22, 33]);
  assert.equal(pipeline.device.syncCount, 1);
});

test("a stop token mid-burst truncates and rewinds the KV cache", async () => {
  // The burst cannot see its own output, so it runs past the stop token. Those
  // extra tokens are in the KV cache and must come back out.
  const pipeline = fakePipeline({ script: [1, 2, 999, 4, 5], stopTokens: [999] });
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 5 });
  const filledBefore = pipeline.filledKVCacheLength;

  const seen = await drain(engine, pipeline, {});

  assert.deepEqual(seen, [1, 2], "nothing after the stop token is emitted");
  assert.deepEqual(pipeline.device.popped, [2], "the 2 unemitted steps are popped");
  assert.equal(pipeline.filledKVCacheLength, filledBefore + 3, "3 forwards survive: 1, 2, stop");
  assert.equal(pipeline.resetCalls, 0, "popn was available, so the cache was kept");
  assertNoLeaks(pipeline);
});

test("without kv_state_popn the cache is dropped rather than left corrupt", async () => {
  const pipeline = fakePipeline({ script: [1, 999, 3], stopTokens: [999], hasPopN: false });
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 3 });

  await drain(engine, pipeline, {});

  assert.equal(pipeline.resetCalls, 1, "next round re-prefills instead of reading phantom tokens");
  assert.equal(pipeline.filledKVCacheLength, 0);
});

test("a new round discards lookahead left over from an interrupted one", async () => {
  const pipeline = fakePipeline({ script: [1, 2, 3, 4, 5] });
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 5 });

  await engine.decode(pipeline, {}); // one burst of 5, one token consumed
  assert.equal(pipeline.device.popped.length, 0);

  await engine.prefill({}, pipeline, {}, {});

  assert.deepEqual(pipeline.device.popped, [4], "the 4 unread tokens leave the cache");
  assert.equal(engine.calls.prefill, 1, "and the real prefill still runs");
});

test("max_tokens clamps the burst instead of overshooting it", () => {
  const pipeline = fakePipeline({ script: [] });
  pipeline.outputIds = new Array(20).fill(0);
  assert.equal(burstSize(pipeline, { max_tokens: 24 }, 15), 4);
  assert.equal(burstSize(pipeline, { max_tokens: 100 }, 15), 15);
});

test("the context window clamps the burst too", () => {
  const pipeline = fakePipeline({ script: [] });
  pipeline.filledKVCacheLength = pipeline.contextWindowSize - 3;
  assert.equal(burstSize(pipeline, {}, 15), 3);
});

test("work needing per-token CPU feedback falls back to single-step", async () => {
  const pipeline = fakePipeline({ script: [1, 2, 3] });
  assert.equal(burstSize(pipeline, { response_format: { type: "json_object" } }, 15), 1);
  assert.equal(burstSize(pipeline, { response_format: { type: "grammar" } }, 15), 1);
  assert.equal(burstSize(pipeline, { logprobs: true }, 15), 1);

  pipeline.logitProcessor = {};
  assert.equal(burstSize(pipeline, {}, 15), 1);

  // and the fallback really is stock WebLLM's decode
  const engine = fakeEngine();
  installMultiStepDecoding(engine, { steps: 15 });
  await engine.decode(pipeline, {});
  assert.equal(engine.calls.decode, 1);
  assert.equal(pipeline.device.syncCount, 0, "the burst path never ran");
});

test("steps=1 leaves decoding bit-identical to stock WebLLM", async () => {
  const pipeline = fakePipeline({ script: [1, 2, 3] });
  const engine = fakeEngine();
  const control = installMultiStepDecoding(engine, { steps: 1 });

  await engine.decode(pipeline, {});

  assert.equal(control.steps, 1);
  assert.equal(engine.calls.decode, 1);
  assert.equal(pipeline.device.syncCount, 0);
});

test("the step count is clamped and retunable without a reload", () => {
  assert.equal(clampSteps(15), 15);
  assert.equal(clampSteps(0), 1);
  assert.equal(clampSteps(-4), 1);
  assert.equal(clampSteps(999), 32);
  assert.equal(clampSteps("13"), 13);
  assert.equal(clampSteps(undefined), 1);

  const control = installMultiStepDecoding(fakeEngine(), { steps: 15 });
  control.setSteps(13);
  assert.equal(control.steps, 13);
});

test("a burst reports its wall time once but its tokens as they drain", async () => {
  const pipeline = fakePipeline({ script: [1, 2, 3, 4] });
  const engine = fakeEngine();
  const bursts = [];
  installMultiStepDecoding(engine, { steps: 4, onBurst: (info) => bursts.push(info) });

  await drain(engine, pipeline, { max_tokens: 5 });

  assert.equal(bursts.length, 1, "one burst");
  assert.equal(bursts[0].steps, 4);
  assert.equal(pipeline.decodingTotalTokens, 4, "usage counts real tokens, not steps attempted");
});

// ------------------------------------------------- the runtime guard (2d) ---

/**
 * The static contract test asks whether a name survives in the *bundle*. These
 * ask the other question: whether it is on the *object we were handed*. A member
 * can survive upstream and still not reach us — moved to a subclass, to another
 * pipeline type, behind a factory — and the symptom is not an exception, it is
 * throughput quietly halving with nothing in the log.
 */
const withoutConsoleError = async (fn) => {
  const original = console.error;
  const said = [];
  console.error = (...args) => said.push(args.join(" "));
  try {
    await fn();
  } finally {
    console.error = original;
  }
  return said;
};

test("a healthy pipeline satisfies the contract", () => {
  assert.deepEqual(missingPipelineMembers(fakePipeline({ script: [1] })), []);
});

test("a renamed method routes to stock decode instead of throwing mid-burst", async () => {
  const pipeline = fakePipeline({ script: [1, 2, 3] });
  pipeline.fsampleWithTopPV2 = pipeline.fsampleWithTopP;
  delete pipeline.fsampleWithTopP;

  const engine = fakeEngine();
  const fallbacks = [];
  const control = installMultiStepDecoding(engine, {
    steps: 15,
    onFallback: (info) => fallbacks.push(info),
  });

  // outputIds starts at length 1, so max_tokens 4 is three more tokens.
  const said = await withoutConsoleError(() => drain(engine, pipeline, { max_tokens: 4 }));

  assert.equal(pipeline.device.syncCount, 0, "no burst was attempted");
  assert.equal(engine.calls.decode, 3, "every token came from stock decode");
  assert.deepEqual(fallbacks[0].missing, ["fsampleWithTopP() is not a function"]);
  assert.equal(said.length, 1, "reported once for the pipeline, not once per token");
  assert.match(said[0], /multi-step decoding disabled/);
  assert.equal(control.fallbacks, 1);
});

test("a missing counter is caught — the failure that would not have thrown", () => {
  // `pipeline.filledKVCacheLength += 1` on an absent member throws nothing: it
  // creates the property, the burst runs, and the KV accounting silently drifts.
  // Presence-only checking would have to *call* something to notice.
  const pipeline = fakePipeline({ script: [1] });
  delete pipeline.filledKVCacheLength;
  assert.deepEqual(missingPipelineMembers(pipeline), ["filledKVCacheLength is not a number"]);
});

test("an absent logitProcessor is not a broken pipeline", () => {
  // It is read as `!== undefined` to decide whether to burst at all, so absent
  // is the normal case. Requiring it would disable the fast path everywhere.
  const pipeline = fakePipeline({ script: [1] });
  assert.equal(pipeline.logitProcessor, undefined);
  assert.deepEqual(missingPipelineMembers(pipeline), []);
  assert.ok(PIPELINE_CONTRACT.optional.includes("logitProcessor"));
});

test("the check runs once per pipeline, not once per decode", async () => {
  const pipeline = fakePipeline({ script: [1, 2, 3, 4, 5, 6] });
  const engine = fakeEngine();

  // `resetChat` is the one declared member a healthy run never touches — it is
  // only the rewind path's last resort — so reads of it count contract scans and
  // nothing else.
  let scans = 0;
  const real = pipeline.resetChat;
  Object.defineProperty(pipeline, "resetChat", {
    get() {
      scans += 1;
      return real;
    },
  });

  installMultiStepDecoding(engine, { steps: 2 });
  await drain(engine, pipeline, { max_tokens: 7 });

  assert.ok(pipeline.device.syncCount > 1, "the run spanned several bursts");
  assert.equal(scans, 1, "the contract was scanned once, not once per burst");
});
