/**
 * Typed failures.
 *
 * Every error the engine raised used to be a bare string, so a caller wanting
 * to tell "this device has no WebGPU" from "that folder was missing a shard"
 * had to match on prose — which then silently broke whenever the prose
 * improved. A code is the part of an error message that is allowed to be
 * depended on.
 *
 * The codes are deliberately few. Each one exists because a caller does
 * something *different* about it, not because it names a different line of
 * code:
 *
 *   NO_WEBGPU             tell the user to check flags/hardware; retrying is futile
 *   NO_MODEL              nothing registered at all — send them to your setup flow
 *   UNKNOWN_MODEL         that id is not resolvable; `listAvailableModels()` says what is
 *   CACHE_INCOMPLETE      a locally-registered model was evicted; re-register the folder
 *   INVALID_MODEL_FOLDER  the folder is not a compiled MLC model; `detail` says what is missing
 *   BAD_REQUEST           the caller's arguments are wrong; a bug in the caller
 *   ABORTED               the caller cancelled it; not a failure, and not to be
 *                         reported to a user as one
 *   GENERATION_FAILED     the model failed mid-generation
 *
 * `message` stays human-readable and stays the thing you print. `detail`
 * carries whatever structured context the site had — the missing cache keys,
 * the absent field — so a caller never has to parse the sentence.
 */
export const ERROR = {
  NO_WEBGPU: "NO_WEBGPU",
  NO_MODEL: "NO_MODEL",
  UNKNOWN_MODEL: "UNKNOWN_MODEL",
  CACHE_INCOMPLETE: "CACHE_INCOMPLETE",
  INVALID_MODEL_FOLDER: "INVALID_MODEL_FOLDER",
  BAD_REQUEST: "BAD_REQUEST",
  ABORTED: "ABORTED",
  GENERATION_FAILED: "GENERATION_FAILED",
};

export class EngineError extends Error {
  /**
   * @param {string} code one of ERROR
   * @param {string} message human-readable, safe to show a user
   * @param {object} [detail] structured context, so callers need not parse `message`
   */
  constructor(code, message, detail) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    if (detail !== undefined) this.detail = detail;
  }

  /** Wire form. `error` stays a plain string so existing callers keep working. */
  toJSON() {
    return { code: this.code, message: this.message, ...(this.detail ? { detail: this.detail } : {}) };
  }
}

/**
 * Normalise anything thrown into an EngineError.
 *
 * Errors from WebLLM, the GPU stack and the structured-clone boundary arrive as
 * plain Errors, DOMExceptions or strings, and a caller should not have to care
 * which. Anything unrecognised becomes `GENERATION_FAILED` rather than being
 * given a more specific code it has not earned.
 */
export function asEngineError(err, fallback = ERROR.GENERATION_FAILED) {
  if (err instanceof EngineError) return err;
  const message = String(err?.message ?? err);
  return new EngineError(fallback, message);
}

export const isEngineError = (err, code) =>
  err instanceof EngineError && (code === undefined || err.code === code);
