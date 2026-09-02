import { useCallback, useRef, useState } from "react";
import { CreateScheduledEngine, isEngineError } from "everything-webgpu";

/**
 * Owns one ScheduledEngine and mirrors its load lifecycle into React state.
 *
 * Loading is triggered explicitly (a button), not from an effect, so React
 * StrictMode's double-invoke never builds two engines. A ref guards against a
 * second concurrent `load()` if the button is somehow clicked twice.
 */
export function useEngine(modelId) {
  const [engine, setEngine] = useState(null);
  const [status, setStatus] = useState("idle"); // idle | loading | ready | error
  const [progress, setProgress] = useState(null); // { text, progress }
  const [error, setError] = useState(null);
  const loadingRef = useRef(false);

  const load = useCallback(async () => {
    if (loadingRef.current || engine) return;
    loadingRef.current = true;
    setStatus("loading");
    setError(null);

    try {
      const next = await CreateScheduledEngine(modelId, {
        initProgressCallback: (report) => setProgress(report),
      });
      setEngine(next);
      setProgress({ text: "ready", progress: 1 });
      setStatus("ready");
    } catch (err) {
      setError(isEngineError(err) ? `${err.code}: ${err.message}` : err.message);
      setStatus("error");
      loadingRef.current = false;
    }
  }, [engine, modelId]);

  return { engine, status, progress, error, load };
}
