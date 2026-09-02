// The one-line migration: this import and `CreateScheduledEngine` are the only
// difference from calling `@mlc-ai/web-llm` directly.
import { CreateScheduledEngine, isEngineError, ERROR } from "everything-webgpu";

const MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

const $ = (id) => document.getElementById(id);
const els = {
  load: $("load"),
  progress: $("progress"),
  status: $("status"),
  ask: $("ask"),
  prompt: $("prompt"),
  send: $("send"),
  out: $("out"),
};

let engine = null;

function setStatus(text) {
  els.status.textContent = text;
}
function setProgress(fraction) {
  els.progress.style.width = `${Math.round((fraction ?? 0) * 100)}%`;
}

// No `navigator.gpu` pre-check here on purpose. `load()` throws `NO_WEBGPU`
// with a message that already names the exact about:config prefs to set —
// re-deriving a worse version of that sentence is how the two drift apart.
els.load.addEventListener("click", async () => {
  els.load.disabled = true;

  try {
    setStatus("Loading — first run downloads the weights, then compiles shaders…");
    engine = await CreateScheduledEngine(MODEL, {
      initProgressCallback: ({ text, progress }) => {
        setStatus(text);
        setProgress(progress);
      },
    });
    setProgress(1);
    setStatus(`Ready — ${MODEL}. Weights are cached now; a reload needs no network.`);
    els.ask.hidden = false;
    els.out.hidden = false;
    els.prompt.focus();
  } catch (err) {
    setProgress(0);
    // Every failure carries a code, and `message` stays the thing you print.
    setStatus(isEngineError(err) ? `${err.code}: ${err.message}` : `Load failed: ${err.message}`);
    // NO_WEBGPU is the one code where retrying is futile — the fix is in
    // about:config and needs a restart, so do not offer the button back.
    els.load.disabled = isEngineError(err, ERROR.NO_WEBGPU);
  }
});

els.ask.addEventListener("submit", async (event) => {
  event.preventDefault();
  const content = els.prompt.value.trim();
  if (!content || !engine) return;

  els.send.disabled = true;
  els.out.textContent = "";
  const startedAt = performance.now();

  try {
    const { text, usage } = await engine.complete(
      {
        messages: [{ role: "user", content }],
        session: "bare-demo", // reusing one key means a fast re-ask supersedes itself
        priority: "interactive",
        max_tokens: 200,
      },
      (delta) => {
        els.out.textContent += delta;
      },
    );

    const seconds = ((performance.now() - startedAt) / 1000).toFixed(1);
    const tps = usage?.extra?.decode_tokens_per_s;
    const meta = document.createElement("span");
    meta.className = "meta";
    meta.textContent =
      `${usage?.completion_tokens ?? text.length} tokens · ${seconds}s` +
      (tps ? ` · ${tps.toFixed(1)} tok/s` : "");
    els.out.append(meta);
  } catch (err) {
    els.out.textContent = isEngineError(err)
      ? `${err.code}: ${err.message}`
      : `Generation failed: ${err.message}`;
  } finally {
    els.send.disabled = false;
  }
});
