/**
 * `environment()` — one call that says what this machine will do, and why.
 *
 * It absorbs the *read* half of `probe()`, `features()` and `estimateSpeed()`.
 * It is **read-only**. Writes go through `configure()`, which already existed
 * and stays the one way to change a setting.
 *
 * That split was a deliberate correction to the original plan, which had one
 * function do both and told them apart by argument shape. Implicit dispatch is
 * the opposite of foolproof: `environment({ scope: "device", decodeSteps: 8 })`
 * has no intuitive answer, and the reason it has none is that one function was
 * being asked to do two jobs. So reading and writing are different verbs, and
 * the report's `fix` field names the write to make instead of performing it.
 *
 * Every line carries the same five fields, because a caller should be able to
 * render the whole report without special-casing any of it:
 *
 *   severity  blocked | degraded | tune | info | ok
 *   affects   what the reader loses — in their terms, not the engine's
 *   cause     the measured fact behind the verdict
 *   fix       the exact call or instruction, or `null` when nothing can be done
 *   operable  whether this is reachable from JS at all
 *
 * `fix` is `null` for anything the caller genuinely cannot change — hardware,
 * build-time flags, browser settings that JS cannot reach. Reporting a
 * consequence with no remedy is still worth doing: "your second turn is slow
 * because this device caps storage buffers at 9" is the difference between a
 * bug report and an informed decision.
 *
 * **`canRun(modelId)` stays where it is.** It is per-*model*; this is
 * per-*device*, and model ranking belongs with model discovery. The two answer
 * different questions and merging them would make both worse.
 */
import { ERROR, EngineError } from "./errors.js";

export const SEVERITY = {
  /** Nothing will run until this is dealt with. */
  BLOCKED: "blocked",
  /** It runs, measurably worse. */
  DEGRADED: "degraded",
  /** It runs well; this is a dial worth turning. */
  TUNE: "tune",
  /** Worth knowing, nothing to do. */
  INFO: "info",
  /** Checked, and fine. */
  OK: "ok",
};

/** Worst-first, so `ok` can be computed and lines sorted by urgency. */
const RANK = [SEVERITY.BLOCKED, SEVERITY.DEGRADED, SEVERITY.TUNE, SEVERITY.INFO, SEVERITY.OK];

/** Paged prefill's binding count; below this, cross-turn KV reuse cannot build. */
const PAGED_PREFILL_STORAGE_BUFFERS = 10;

const SCOPES = new Set(["full", "local", "device"]);

/**
 * Builds the callable `engine.environment` — a function with `.measure()` on it.
 *
 * A function rather than an object because the common case is asking for the
 * whole report, and `environment()` should be the short spelling of that.
 *
 * @param {import("./engine.js").ScheduledEngine} engine
 */
export function environmentFacade(engine) {
  const environment = (opts = {}) => report(engine, opts);

  /**
   * One calibration generation, then the measured rate.
   *
   * Returns tok/s for the **current model** — the only one it can measure,
   * since measuring means generating. The device-level bytes/sec figure it
   * teaches the engine is what projects *other* models, and that projection is
   * `estimateSpeed(id)`'s job, not this one's.
   */
  environment.measure = async ({ tokens = 32 } = {}) => {
    const modelId = engine.state.modelId;
    if (!modelId || engine.resident.length === 0) {
      throw new EngineError(
        ERROR.NO_MODEL,
        "environment.measure() generates in order to measure, so it needs a resident model. " +
          "Call load() first, or use estimateSpeed(id) for a projection.",
      );
    }
    await engine.complete({
      messages: [{ role: "user", content: "Count from one to twenty." }],
      max_tokens: tokens,
      // Calibration must not jump a queue a real caller is waiting in.
      priority: "background",
      preemptible: true,
    });
    return { ...(await engine.estimateSpeed(modelId)), tokens };
  };

  return environment;
}

async function report(engine, { scope = "full", ...rest } = {}) {
  // The one thing an implicit read/write API could not do: notice that a caller
  // meant to write. `configure()` is named in the error because that is the
  // call they wanted.
  const stray = Object.keys(rest);
  if (stray.length) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `environment() reports; it does not change anything. ` +
        `To set ${stray.map((k) => `\`${k}\``).join(", ")}, call configure({ ${stray.join(", ")} }).`,
      { keys: stray },
    );
  }
  if (!SCOPES.has(scope)) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `environment() scope must be ${[...SCOPES].map((s) => `"${s}"`).join(", ")}, not "${scope}".`,
      { scope },
    );
  }

  const device = await engine.probe();
  const lines = [...deviceLines(device)];

  // A blocked device short-circuits everything below it. "K=15 forward steps
  // per GPU sync" is true and completely useless next to "no model can load" —
  // and burying the one line that matters under four that do not is exactly the
  // failure this report exists to prevent.
  const blocked = lines.some((l) => l.severity === SEVERITY.BLOCKED);

  if (scope !== "device" && !blocked) {
    const features = await engine.features();
    const settings = await engine.store.getSettings();
    lines.push(...runtimeLines(engine, device, features, settings));
  }

  // `full` is the only scope that may touch the network: `estimateSpeed` reads
  // the model list, which pulls the ~6 MB WebLLM bundle when prebuilt models
  // are on. `local` exists precisely so a caller can ask cheaply and often.
  let speed = null;
  if (scope === "full" && !blocked && engine.state.modelId) {
    speed = await engine.estimateSpeed().catch(() => null);
  }

  lines.sort((a, b) => RANK.indexOf(a.severity) - RANK.indexOf(b.severity));
  const worst = lines.reduce(
    (acc, l) => (RANK.indexOf(l.severity) < RANK.indexOf(acc) ? l.severity : acc),
    SEVERITY.OK,
  );

  return {
    scope,
    ok: worst !== SEVERITY.BLOCKED,
    severity: worst,
    device,
    ...(speed ? { speed } : {}),
    lines,
  };
}

const line = (id, severity, affects, cause, fix = null) => ({
  id,
  severity,
  affects,
  cause,
  fix,
  operable: fix !== null,
});

function* deviceLines(device) {
  if (!device.webgpu) {
    // `reason` already carries the exact per-browser instruction, and it is not
    // reachable from JS — so it is the fix text, not an operable one.
    yield {
      ...line("webgpu", SEVERITY.BLOCKED, "everything — no model can load", device.reason ?? "navigator.gpu is absent"),
      fix: device.reason ?? null,
      operable: false,
    };
    return;
  }
  yield line("webgpu", SEVERITY.OK, null, "navigator.gpu is present and an adapter was granted");

  const buffers = device.limits?.maxStorageBuffersPerShaderStage;
  if (device.kvReuse === false) {
    yield line(
      "kvReuse",
      SEVERITY.DEGRADED,
      "every turn after the first re-prefills the whole history, so a long conversation waits seconds for its first token",
      `paged prefill binds ${PAGED_PREFILL_STORAGE_BUFFERS} storage buffers per stage; this device allows ${buffers ?? "fewer"}`,
      // Genuinely not operable: it is a driver/browser limit, not a setting.
      null,
    );
  } else if (device.kvReuse) {
    yield line("kvReuse", SEVERITY.OK, null, `storage buffers per stage: ${buffers}`);
  }

  yield device.features?.shaderF16
    ? line("shaderF16", SEVERITY.OK, null, "shader-f16 is supported, so q4f16 models run at full speed")
    : line(
        "shaderF16",
        SEVERITY.DEGRADED,
        "q4f16 models fall back to f32 maths, roughly halving decode",
        "the adapter does not expose shader-f16",
        null,
      );

  const { quota, usage, persisted } = device.storage ?? {};
  if (persisted === false) {
    yield line(
      "persist",
      SEVERITY.TUNE,
      "the browser may evict a multi-GB model under storage pressure, forcing a re-download",
      "storage is not marked persistent",
      "await ensurePersistent() — from everything-webgpu/adapters/idb. One-way, and may prompt.",
    );
  } else if (persisted) {
    yield line("persist", SEVERITY.OK, null, "storage is persistent; models will not be evicted");
  }

  if (quota && usage !== undefined) {
    const freeGB = (quota - usage) / 1e9;
    yield freeGB < 2
      ? line(
          "quota",
          SEVERITY.DEGRADED,
          "a model may fail to cache, or evict one already there",
          `${freeGB.toFixed(1)} GB free of ${(quota / 1e9).toFixed(1)} GB`,
          "Free space, or remove(id) a model you no longer need.",
        )
      : line("quota", SEVERITY.INFO, null, `${freeGB.toFixed(1)} GB free of ${(quota / 1e9).toFixed(1)} GB`);
  }
}

function* runtimeLines(engine, device, features, settings) {
  // The 2d guard's report. Nothing else surfaces it, and its whole point is
  // that the failure is otherwise silent.
  const off = engine.state.decode?.multiStepOff;
  if (off?.length) {
    yield line(
      "multiStepDecoding",
      SEVERITY.DEGRADED,
      "decode fell back to one GPU sync per token — roughly half throughput",
      `the live pipeline is missing ${off.length} tvmjs internal(s): ${off.slice(0, 3).join("; ")}`,
      "This is what a WebLLM upgrade looks like. Run `npm test` (webllm-contract) to see whether the names are gone from the bundle too.",
    );
  } else if (features.multiStepDecoding) {
    yield line("multiStepDecoding", SEVERITY.OK, null, `K=${features.decodeSteps} forward steps per GPU sync`);
  }

  yield features.decodeSteps === 1
    ? line(
        "decodeSteps",
        SEVERITY.TUNE,
        "decode pays one GPU sync per token, which is the ~10 tok/s ceiling",
        "decodeSteps is 1, so multi-step decoding is off",
        "configure({ decodeSteps: 15 })",
      )
    : line(
        "decodeSteps",
        SEVERITY.INFO,
        null,
        `K=${features.decodeSteps}; the best value falls as the model grows, since it is ms/step that fills the 100 ms tick`,
        "configure({ decodeSteps: n })",
      );

  yield line(
    "engineCount",
    SEVERITY.INFO,
    null,
    `pool cap ${features.maxEngines}, ${features.engines} built; it grows only when a second task waits`,
    "configure({ engineCount: n }) — persisted, and applies to pools built after it",
  );

  // Observed, not asserted: a build with NO_PASS_MERGE=1 reports ~1.
  const batching = features.computePassBatching;
  if (batching !== null) {
    yield batching > 1.5
      ? line("computePassBatching", SEVERITY.OK, null, `${batching.toFixed(1)} kernel launches per flush`)
      : line(
          "computePassBatching",
          SEVERITY.DEGRADED,
          "one compute pass per kernel launch, which measured ~2.5x slower",
          `${batching.toFixed(1)} launches per flush — the build-time patch is not in effect`,
          // Build-time, not runtime: nothing a caller holding the engine can do.
          null,
        );
  }

  if (settings.engineCount && features.maxEngines && settings.engineCount !== features.maxEngines) {
    yield line(
      "engineCountPending",
      SEVERITY.INFO,
      null,
      `engineCount is ${settings.engineCount} but the live pool was built with ${features.maxEngines}`,
      "Reload the model to apply it.",
    );
  }
}
