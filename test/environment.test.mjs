/**
 * `environment()` — the read-only report.
 *
 * The design decision under test is that reading and writing are different
 * verbs. The original plan had one function do both, told apart by argument
 * shape; these assert the correction, and in particular that a caller who
 * *tries* to write through it is sent to `configure()` by name rather than
 * silently ignored.
 *
 * The rest is the report's own contract: every line carries the same five
 * fields, `fix` is non-null exactly when something is operable, and the scopes
 * differ in what they are allowed to touch.
 */
import { test } from "node:test";
import assert from "node:assert/strict";

import { installCacheStorage } from "./harness.mjs";

installCacheStorage();
/**
 * Records its message listeners so a test can deliver the `ewgpuStats` post the
 * real engine worker sends. That is the only way `state.decode` is ever set, so
 * faking the state directly would test nothing about the path.
 */
const workers = [];
globalThis.Worker = class {
  #listeners = [];
  constructor() {
    workers.push(this);
  }
  addEventListener(_type, fn) {
    this.#listeners.push(fn);
  }
  /** Stands in for the worker posting its decode probe. */
  emit(data) {
    for (const fn of this.#listeners) fn({ data });
  }
  postMessage() {}
  terminate() {}
};

const { ScheduledEngine } = await import("../src/engine/engine.js");
const { ModelStore } = await import("../src/engine/model-store.js");
const { SEVERITY } = await import("../src/engine/environment.js");
const { memoryStorage } = await import("../src/adapters/memory.js");

const MODEL = "Test-1B-q4f16_1-MLC";

/** A device that works. Override `limits` to make it not. */
const goodGpu = ({ buffers = 10, f16 = true } = {}) => ({
  requestAdapter: async () => ({
    features: new Set(f16 ? ["shader-f16"] : []),
    limits: { maxStorageBuffersPerShaderStage: buffers },
    info: { vendor: "apple", architecture: "m4" },
  }),
});

function engineWith({ gpu = goodGpu(), storage: quota, prebuilt = true } = {}) {
  globalThis.navigator = {
    ...(gpu ? { gpu } : {}),
    storage: quota
      ? { estimate: async () => quota, persisted: async () => quota.persisted ?? false }
      : undefined,
  };
  let loads = 0;
  const engine = new ScheduledEngine({
    store: new ModelStore(memoryStorage()),
    prebuilt,
    workerUrl: "about:blank",
    loadWebLLM: async () => {
      loads += 1;
      return {
        prebuiltAppConfig: {
          model_list: [{ model_id: MODEL, model: "https://cdn/x", model_lib: "https://cdn/x.wasm", vram_required_MB: 900 }],
        },
        CreateWebWorkerMLCEngine: async () => ({
          chat: {
            completions: {
              create: async () =>
                (async function* () {
                  yield { choices: [{ delta: { content: "ok" }, finish_reason: null }] };
                  yield {
                    choices: [{ delta: {}, finish_reason: "stop" }],
                    usage: { total_tokens: 4, extra: { decode_tokens_per_s: 20 } },
                  };
                })(),
            },
          },
          interruptGenerate() {},
          unload: async () => {},
        }),
      };
    },
  });
  return { engine, loads: () => loads };
}

// --------------------------------------------------------- read, not write ---

test("environment() refuses a write and names the call that does it", async () => {
  // The whole reason read and write are separate verbs. Silently ignoring
  // `decodeSteps` here is the failure mode the split exists to prevent.
  const { engine } = engineWith();
  await assert.rejects(
    () => engine.environment({ decodeSteps: 8 }),
    (err) =>
      err.code === "BAD_REQUEST" &&
      /does not change anything/.test(err.message) &&
      /configure\(\{ decodeSteps \}\)/.test(err.message),
  );
});

test("the ambiguous mixed call from the plan's open question is refused too", async () => {
  // `{ scope: "device", decodeSteps: 8 }` had no intuitive answer, which is
  // what showed one function was doing two jobs.
  const { engine } = engineWith();
  await assert.rejects(
    () => engine.environment({ scope: "device", decodeSteps: 8 }),
    /configure\(\{ decodeSteps \}\)/,
  );
});

test("an unknown scope is refused with the valid ones", async () => {
  const { engine } = engineWith();
  await assert.rejects(() => engine.environment({ scope: "everything" }), /must be "full", "local", "device"/);
});

// ------------------------------------------------------- the report itself ---

test("every line carries the same five fields, and fix matches operable", async () => {
  // A caller should be able to render the whole report without special-casing
  // any line — and `operable` must never disagree with `fix`.
  const { engine } = engineWith({ storage: { quota: 40e9, usage: 1e9, persisted: false } });
  const report = await engine.environment();

  assert.ok(report.lines.length >= 5, `expected a substantive report, got ${report.lines.length} lines`);
  for (const l of report.lines) {
    assert.deepEqual(
      Object.keys(l).sort(),
      ["affects", "cause", "fix", "id", "operable", "severity"],
      `line ${l.id} has the wrong shape`,
    );
    assert.ok(Object.values(SEVERITY).includes(l.severity), `line ${l.id} has severity ${l.severity}`);
    assert.equal(l.operable, l.fix !== null, `line ${l.id}: operable and fix disagree`);
    assert.equal(typeof l.cause, "string", `line ${l.id} must say why`);
  }
});

test("lines are ordered worst first, and `ok` reflects the worst", async () => {
  const { engine } = engineWith({ gpu: null });
  const report = await engine.environment();

  assert.equal(report.ok, false, "no WebGPU means nothing will run");
  assert.equal(report.severity, SEVERITY.BLOCKED);
  assert.equal(report.lines[0].id, "webgpu");
  assert.equal(report.lines[0].severity, SEVERITY.BLOCKED);
  // Blocked at the device level: nothing past it is worth reporting.
  assert.equal(report.lines.length, 1);
});

test("a healthy device reports ok and nothing blocking", async () => {
  const { engine } = engineWith({ storage: { quota: 40e9, usage: 1e9, persisted: true } });
  const report = await engine.environment();

  assert.equal(report.ok, true);
  assert.notEqual(report.severity, SEVERITY.BLOCKED);
  const byId = Object.fromEntries(report.lines.map((l) => [l.id, l]));
  assert.equal(byId.webgpu.severity, SEVERITY.OK);
  assert.equal(byId.kvReuse.severity, SEVERITY.OK);
  assert.equal(byId.shaderF16.severity, SEVERITY.OK);
  assert.equal(byId.persist.severity, SEVERITY.OK);
});

test("the 9-buffer device reports the consequence, with no fix to offer", async () => {
  // This is the case the whole `fix: null` idea exists for: a real, measurable
  // degradation that the caller genuinely cannot act on from JS. Reporting the
  // consequence is still the difference between a bug report and a decision.
  const { engine } = engineWith({ gpu: goodGpu({ buffers: 9 }) });
  const report = await engine.environment();
  const kv = report.lines.find((l) => l.id === "kvReuse");

  assert.equal(kv.severity, SEVERITY.DEGRADED);
  assert.equal(kv.fix, null, "a driver limit is not operable");
  assert.equal(kv.operable, false);
  assert.match(kv.cause, /10 storage buffers.*allows 9/s);
  assert.match(kv.affects, /re-prefills/, "it must say what the reader loses");
});

test("no shader-f16 and unpersisted storage are told apart by severity", async () => {
  const { engine } = engineWith({
    gpu: goodGpu({ f16: false }),
    storage: { quota: 40e9, usage: 1e9, persisted: false },
  });
  const byId = Object.fromEntries((await engine.environment()).lines.map((l) => [l.id, l]));

  // Hardware: degraded, nothing to do.
  assert.equal(byId.shaderF16.severity, SEVERITY.DEGRADED);
  assert.equal(byId.shaderF16.fix, null);
  // A one-way call the caller can actually make: a dial, not a defect.
  assert.equal(byId.persist.severity, SEVERITY.TUNE);
  assert.match(byId.persist.fix, /ensurePersistent/);
});

test("a nearly-full disk is degraded, a roomy one is just info", async () => {
  // One at a time: `engineWith` installs `globalThis.navigator`, so building
  // both first would have the second one's disk answer for both.
  const quotaLine = async (storage) =>
    (await engineWith({ storage }).engine.environment()).lines.find((l) => l.id === "quota");

  const t = await quotaLine({ quota: 10e9, usage: 9.5e9, persisted: true });
  const r = await quotaLine({ quota: 40e9, usage: 1e9, persisted: true });
  assert.equal(t.severity, SEVERITY.DEGRADED);
  assert.match(t.fix, /remove\(id\)/);
  assert.equal(r.severity, SEVERITY.INFO);
  assert.equal(r.fix, null);
});

// -------------------------------------------------------------- the scopes ---

test("scope 'device' stops at the hardware; 'local' adds runtime but no fetch", async () => {
  const { engine, loads } = engineWith();

  const device = await engine.environment({ scope: "device" });
  assert.ok(device.lines.every((l) => !["decodeSteps", "engineCount"].includes(l.id)));
  assert.equal(loads(), 0, "a device probe must not fetch the 6 MB bundle");

  const local = await engine.environment({ scope: "local" });
  assert.ok(local.lines.some((l) => l.id === "decodeSteps"), "local includes runtime settings");
  assert.equal(loads(), 0, "and still must not fetch it");
});

test("'local' never consults the model layer; only 'full' does", async () => {
  // Tested structurally rather than by counting fetches. `estimateSpeed()` only
  // reaches the network when it does not already know the model's size, and
  // `load()` caches that — so after a load neither scope would fetch, and a
  // fetch counter cannot tell the two apart. What `local` actually promises is
  // that it does not go near the model layer at all, whatever that layer would
  // have cost this time.
  const { engine } = engineWith();
  await engine.load(MODEL);

  let consulted = 0;
  const real = engine.estimateSpeed.bind(engine);
  engine.estimateSpeed = (...args) => {
    consulted += 1;
    return real(...args);
  };

  await engine.environment({ scope: "local" });
  await engine.environment({ scope: "device" });
  assert.equal(consulted, 0, "local and device must not touch the model layer");

  const full = await engine.environment();
  assert.equal(consulted, 1, "full does");
  assert.ok(full.speed, "and carries the projection it went for");
  assert.equal(full.speed.modelId, MODEL);
});

// ------------------------------------------------------ the 2d tie-in, and measure ---

test("a silently disabled fast path is what the report is for", async () => {
  // multistep.js's runtime guard (§2d) posts `multiStepOff` and nothing
  // consumed it until now. Its entire failure mode is being invisible: correct
  // tokens, half the throughput, nothing in the log.
  const { engine } = engineWith();
  workers.length = 0;
  await engine.load(MODEL);

  const healthy = (await engine.environment({ scope: "local" })).lines.find(
    (l) => l.id === "multiStepDecoding",
  );
  assert.equal(healthy.severity, SEVERITY.OK);

  // Exactly what engine-worker.js's `onFallback` posts.
  workers.at(-1).emit({
    ewgpuStats: { steps: 15, multiStepOff: ["fsampleWithTopP() is not a function"] },
  });

  const ms = (await engine.environment({ scope: "local" })).lines.find(
    (l) => l.id === "multiStepDecoding",
  );
  assert.equal(ms.severity, SEVERITY.DEGRADED, "a disabled fast path must not read as healthy");
  assert.match(ms.cause, /fsampleWithTopP/, "and must name what went missing");
  assert.match(ms.affects, /half throughput/);
});

test("measure() needs a resident model and says so", async () => {
  const { engine } = engineWith();
  await assert.rejects(
    () => engine.environment.measure(),
    (err) => err.code === "NO_MODEL" && /generates in order to measure/.test(err.message),
  );
});

test("measure() returns tok/s for the current model", async () => {
  const { engine } = engineWith();
  await engine.load(MODEL);
  const measured = await engine.environment.measure({ tokens: 4 });
  assert.equal(measured.modelId, MODEL, "the only model it can measure is the one that is up");
  assert.equal(measured.tokens, 4);
  assert.ok(typeof measured.tokensPerSecond === "number");
});

// --------------------------------------------------- writes go to configure ---

test("configure accepts exactly the knobs the report calls operable", async () => {
  const { engine } = engineWith();
  const report = await engine.environment({ scope: "local" });
  const operable = report.lines.filter((l) => l.fix?.startsWith("configure("));

  assert.ok(operable.length >= 2, "the report should name configure() for the hot knobs");
  for (const l of operable) {
    // Each `fix` naming configure() must be a knob configure() really takes —
    // otherwise the report is telling people to make a call that throws.
    const knob = l.fix.match(/configure\(\{ (\w+)/)[1];
    const res = await engine.configure({ [knob]: knob === "decodeSteps" ? 8 : 3 });
    assert.ok(knob in res.settings, `configure() ignored \`${knob}\`, which environment() advertised`);
  }
});

test("configure refuses a knob it cannot apply, and lists the ones it can", async () => {
  const { engine } = engineWith();
  await assert.rejects(() => engine.configure({}), /Operable: `decodeSteps`, `engineCount`/);
  await assert.rejects(() => engine.configure({ engineCount: 0 }), /positive integer/);
  await assert.rejects(() => engine.configure({ engineCount: "lots" }), /positive integer/);
});
