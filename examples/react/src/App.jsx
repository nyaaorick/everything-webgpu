import { useEffect, useMemo, useRef, useState } from "react";
import { isEngineError } from "everything-webgpu";
import { useEngine } from "./useEngine.js";

const MODEL = "Llama-3.2-1B-Instruct-q4f16_1-MLC";

export function App() {
  const { engine, status, progress, error, load } = useEngine(MODEL);

  // One conversation for the life of the engine: every turn shares its task, so
  // it holds at most one engine and history is bounded for you.
  const chat = useMemo(() => (engine ? engine.conversation({ system: "You are terse." }) : null), [engine]);

  const [log, setLog] = useState([]); // { role, content }[]
  const [draft, setDraft] = useState("Name three primary colours.");
  const [busy, setBusy] = useState(false);
  const scroller = useRef(null);

  useEffect(() => {
    scroller.current?.scrollTo(0, scroller.current.scrollHeight);
  }, [log]);

  async function send(event) {
    event.preventDefault();
    const content = draft.trim();
    if (!content || !chat || busy) return;

    setDraft("");
    setBusy(true);
    setLog((l) => [...l, { role: "user", content }, { role: "assistant", content: "" }]);

    try {
      await chat.say(content, (delta) => {
        setLog((l) => {
          const next = l.slice();
          next[next.length - 1] = { role: "assistant", content: next.at(-1).content + delta };
          return next;
        });
      });
    } catch (err) {
      const message = isEngineError(err) ? `${err.code}: ${err.message}` : err.message;
      setLog((l) => {
        const next = l.slice();
        next[next.length - 1] = { role: "error", content: message };
        return next;
      });
    } finally {
      setBusy(false);
    }
  }

  return (
    <main style={styles.main}>
      <h1 style={styles.h1}>everything-webgpu — Vite + React</h1>
      <p style={styles.sub}>
        A chat UI over <code>engine.conversation()</code>. Streaming deltas land through the
        <code> onDelta</code> callback; history is bounded by the recipe.
      </p>

      {status !== "ready" && (
        <section>
          <button onClick={load} disabled={status === "loading"} style={styles.button}>
            {status === "loading" ? "Loading…" : `Load ${MODEL}`}
          </button>
          <div style={styles.bar}>
            <i style={{ ...styles.barFill, width: `${Math.round((progress?.progress ?? 0) * 100)}%` }} />
          </div>
          <p style={styles.status}>
            {error ??
              progress?.text ??
              (status === "loading"
                ? "First run downloads ~0.8 GB, then compiles shaders."
                : "Idle.")}
          </p>
        </section>
      )}

      {status === "ready" && (
        <>
          <div ref={scroller} style={styles.log}>
            {log.length === 0 && <p style={styles.empty}>Ask something.</p>}
            {log.map((m, i) => (
              <div key={i} style={{ ...styles.msg, ...(styles[m.role] ?? {}) }}>
                {m.content || (m.role === "assistant" && busy ? "…" : "")}
              </div>
            ))}
          </div>
          <form onSubmit={send} style={styles.form}>
            <input
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              placeholder="Ask the local model…"
              style={styles.input}
            />
            <button type="submit" disabled={busy} style={styles.button}>
              Send
            </button>
          </form>
        </>
      )}
    </main>
  );
}

const styles = {
  main: { font: "15px/1.5 system-ui, sans-serif", maxWidth: "46rem", margin: "0 auto", padding: "2rem" },
  h1: { fontSize: "1.1rem", marginBottom: "0.25rem" },
  sub: { opacity: 0.7, marginTop: 0 },
  button: { padding: "0.5rem 1rem", font: "inherit" },
  bar: { height: 4, background: "rgba(127,127,127,0.25)", borderRadius: 2, overflow: "hidden", margin: "0.75rem 0" },
  barFill: { display: "block", height: "100%", background: "currentColor", transition: "width 0.2s" },
  status: { font: "13px ui-monospace, monospace", opacity: 0.8, minHeight: "1.5em" },
  log: {
    border: "1px solid rgba(127,127,127,0.4)",
    borderRadius: 6,
    padding: "0.75rem",
    height: "24rem",
    overflowY: "auto",
    display: "flex",
    flexDirection: "column",
    gap: "0.5rem",
  },
  empty: { opacity: 0.5, margin: 0 },
  msg: { padding: "0.5rem 0.7rem", borderRadius: 6, whiteSpace: "pre-wrap", maxWidth: "80%" },
  user: { background: "rgba(80,140,255,0.18)", alignSelf: "flex-end" },
  assistant: { background: "rgba(127,127,127,0.15)", alignSelf: "flex-start" },
  error: { background: "rgba(255,80,80,0.18)", alignSelf: "flex-start" },
  form: { display: "flex", gap: "0.5rem", marginTop: "1rem" },
  input: { flex: 1, padding: "0.5rem 0.6rem", font: "inherit" },
};
