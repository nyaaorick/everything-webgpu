import { ScheduledEngine, ModelStore } from "everything-webgpu";
import { indexedDBStorage } from "everything-webgpu/adapters/idb";

const out = document.querySelector("pre");
const log = (message) => {
  out.textContent += `${message}\n`;
  console.log(`[debug] ${message}`);
};
const check = (condition, message) => { if (!condition) throw new Error(message); };
const timed = async (fn) => {
  const start = performance.now();
  const value = await fn();
  return { value, ms: performance.now() - start };
};

window.runGPU = async ({ modelId, modelLib, repeats = 20 }) => {
  const result = { checks: [], requests: [] };
  const adapter = await navigator.gpu?.requestAdapter();
  check(adapter, "No usable WebGPU adapter");
  result.device = {
    userAgent: navigator.userAgent,
    cores: navigator.hardwareConcurrency,
    info: adapter.info?.toJSON?.() ?? {
      vendor: adapter.info?.vendor, architecture: adapter.info?.architecture,
      description: adapter.info?.description,
    },
    storageBuffers: adapter.limits.maxStorageBuffersPerShaderStage,
    shaderF16: adapter.features.has("shader-f16"),
  };
  log(`adapter: ${JSON.stringify(result.device)}`);
  const store = new ModelStore(await indexedDBStorage());
  // Bound the test to one model copy and 4k context; decode uses the default K.
  await store.setSettings({ engineCount: 1 });
  const engine = window.engine = new ScheduledEngine({ store, prebuilt: false });
  await engine.registerModel({
    modelId, model: `${location.origin}/models/resolve/main/`,
    modelLib: `${location.origin}/models/${modelLib}`, contextWindow: 4096,
  });
  let previousProgress;
  const unsubscribe = engine.subscribe((state) => {
    const step = Math.floor((state.progress?.progress ?? 0) * 10);
    if (state.status === "loading" && step !== previousProgress) {
      previousProgress = step;
      log(`loading ${state.progress?.text ?? ""}`);
    }
  });
  const loaded = await timed(() => engine.load(modelId));
  result.loadMs = loaded.ms;
  unsubscribe();
  log(`model loaded in ${loaded.ms.toFixed(0)}ms`);
  const messages = [{ role: "user", content: "Reply with exactly: hello" }];
  const request = (extra = {}) => engine.chat.completions.create({
    model: modelId, messages, max_tokens: 16, temperature: 0, ...extra,
  });
  const first = await timed(() => request());
  check(first.value.choices?.[0]?.message?.content?.trim(), "Non-streaming reply is empty");
  check(first.value.choices[0].finish_reason, "Missing finish reason");
  result.first = { ms: first.ms, reply: first.value.choices[0].message.content, usage: first.value.usage };
  result.checks.push("non-streaming");
  log(`first reply: ${JSON.stringify(result.first)}`);
  const streamed = await timed(async () => {
    let text = "", chunks = 0, finish = null;
    for await (const chunk of await request({ stream: true })) {
      check(chunk.object === "chat.completion.chunk", "Invalid streamed object type");
      text += chunk.choices?.[0]?.delta?.content ?? "";
      finish = chunk.choices?.[0]?.finish_reason ?? finish;
      chunks++;
    }
    check(text.trim() && chunks && finish, "Incomplete stream lifecycle");
    return { text, chunks, finish };
  });
  result.stream = { ...streamed.value, ms: streamed.ms };
  result.checks.push("streaming");
  for (let i = 0; i < repeats; i++) {
    const run = await timed(() => request({ task: "repeat" }));
    check(run.value.choices?.[0]?.message?.content?.trim(), `Empty reply ${i + 1}`);
    result.requests.push({ ms: run.ms, reply: run.value.choices[0].message.content, usage: run.value.usage });
    log(`repeat ${i + 1}/${repeats}: ${run.ms.toFixed(0)}ms`);
  }
  result.checks.push(`${repeats} repeated requests`);
  const chat = engine.conversation({ system: "Answer briefly.", keep: 4, max_tokens: 24, temperature: 0 });
  const { text: a } = await chat.say("My name is Ada. What is my name?");
  const { text: b } = await chat.say("What name did I tell you?");
  result.conversation = { a, b };
  check(a.trim() && b.trim(), "Multi-turn response is empty");
  check(/ada/i.test(b), "Second turn did not recall Ada");
  result.checks.push("multi-turn recall");
  const concurrent = await Promise.all([request({ task: "alpha" }), request({ task: "beta" })]);
  check(concurrent.every((r) => r.choices?.[0]?.message?.content?.trim()), "Concurrent request failed");
  result.checks.push("concurrent callers (one-engine queue)");
  const id = crypto.randomUUID();
  let cancelCount = 0, cancelledChunks = 0;
  try {
    for await (const chunk of await request({ id, stream: true, max_tokens: 256,
      messages: [{ role: "user", content: "Count from one to one hundred in words." }] })) {
      if (chunk.choices?.[0]?.delta?.content && !cancelCount) cancelCount = engine.cancel(id);
      cancelledChunks++;
    }
  } catch (error) {
    check(error.code === "ABORTED", `Unexpected cancellation error: ${error.code}: ${error.message}`);
  }
  check(cancelCount > 0, "Cancellation did not find the running request");
  result.cancel = { cancelCount, cancelledChunks };
  result.checks.push("stream cancellation");
  check((await request()).choices[0].message.content.trim(), "No recovery after cancellation");
  result.checks.push("post-cancellation recovery");
  result.features = await engine.features();
  result.state = engine.state;
  await engine.unload();
  const reloaded = await timed(() => engine.load(modelId));
  result.reloadMs = reloaded.ms;
  check((await request()).choices[0].message.content.trim(), "No reply after reload");
  result.checks.push("unload and cached reload");
  await engine.unload();
  log(`GPU checks complete: ${result.checks.join(", ")}`);
  return result;
};

window.runNoGPU = async ({ modelId, modelLib }) => {
  Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  const store = new ModelStore(await indexedDBStorage());
  const engine = new ScheduledEngine({ store, prebuilt: false });
  await engine.registerModel({ modelId, model: `${location.origin}/models/resolve/main/`, modelLib: `${location.origin}/models/${modelLib}` });
  try {
    await engine.load(modelId);
    throw new Error("Load unexpectedly succeeded without WebGPU");
  } catch (error) {
    check(error.code === "NO_WEBGPU", `Unexpected unavailable-GPU error: ${error.code}: ${error.message}`);
    log(`no GPU: ${error.code}`);
    return { code: error.code, message: error.message };
  }
};

window.runCPU = async () => {
  // Separate feasibility prototype; not an integrated engine fallback.
  Object.defineProperty(navigator, "gpu", { value: undefined, configurable: true });
  const { Wllama } = await import("@wllama/wllama");
  const wllama = new Wllama({ default: `${location.origin}/cpu/wllama.wasm` });
  try {
    const load = await timed(() => wllama.loadModelFromUrl(`${location.origin}/cpu/stories260K.gguf`, {
      n_threads: 1, n_gpu_layers: 0, n_ctx: 256,
    }));
    const runs = [];
    for (let i = 0; i < 3; i++) {
      const run = await timed(() => wllama.createCompletion({
        prompt: "Once upon a time", max_tokens: 32, temperature: 0, seed: 42,
      }));
      const text = run.value.choices?.[0]?.text;
      check(text?.trim(), "CPU prototype generated no text");
      runs.push({ ms: run.ms, text, usage: run.value.usage });
    }
    log(`CPU-only prototype: ${JSON.stringify(runs)}`);
    return { model: "stories260K.gguf", loadMs: load.ms, threads: 1, gpuLayers: 0, webgpu: Boolean(navigator.gpu), runs };
  } finally {
    await wllama.exit();
  }
};
log("Ready for Edge/Firefox debug verification");
