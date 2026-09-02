/**
 * Engine vocabulary — the words the scheduler itself is defined in.
 *
 * Deliberately transport-free. A caller holding a `ScheduledEngine` uses these
 * directly; a caller reaching the engine over a message port gets them
 * re-exported from `src/adapters/protocol.js` alongside the wire ops. Keeping
 * the split visible is the point: the wire protocol is one adapter, not the
 * interface.
 */

/**
 * Scheduling bands, highest first. `interactive` may preempt a running job that
 * opted into `preemptible`; nothing else ever interrupts work in flight.
 */
export const PRIORITY = {
  /** Ghost-text and anything else a human is waiting on keystroke-by-keystroke. */
  INTERACTIVE: "interactive",
  /** Default. Translation, one-shot answers. */
  NORMAL: "normal",
  /** Nobody is watching: reformatting, batch cleanup. Pair with `preemptible`. */
  BACKGROUND: "background",
};

export const PRIORITY_ORDER = [PRIORITY.INTERACTIVE, PRIORITY.NORMAL, PRIORITY.BACKGROUND];

/**
 * How far `unload()` goes.
 *
 * Two levels rather than two verbs because they are the same intention at
 * different depths — "I am done with this model" — and the caller should not
 * have to know that freeing VRAM and freeing disk are different subsystems.
 * Forgetting the model *entirely* is `remove()`, which stays its own verb
 * because it is the one that cannot be undone without re-supplying the source.
 */
export const UNLOAD_LEVEL = {
  /** Default. Free VRAM, keep the cached bytes — so reloading costs no network. */
  VRAM: "vram",
  /** Also delete the cached bytes. The registry entry survives, so the model is still known. */
  CACHE: "cache",
};

/**
 * What a queued job asks its engine to do.
 *
 * One pool, not two: priority, session supersession, preemption and
 * one-task-one-engine are identical for both, and the only thing that differs
 * is the call at the far end. A second pool would have duplicated the
 * scheduler to change one line.
 */
export const JOB_KIND = {
  CHAT: "chat",
  EMBEDDING: "embedding",
};

/** Engine lifecycle states. */
export const ENGINE_STATE = {
  IDLE: "idle",
  LOADING: "loading",
  READY: "ready",
  ERROR: "error",
};

/**
 * Out-of-band message kind for configuring an engine worker before WebLLM's own
 * handshake starts. Distinct from every WebLLM `kind`, so the worker can route
 * on it without parsing the rest.
 */
export const WORKER_CONFIGURE = "everything-webgpu/configure";
