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
