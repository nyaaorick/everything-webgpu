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
 *   PACKAGE_INCOMPLETE    this package is not wired into your build correctly —
 *                         a missing `vendor/` bundle, or a decode worker the
 *                         bundler did not emit. Fixed once, in the build, by
 *                         the developer; never branched on at runtime.
 *   NO_ENGINE_HOST        the engine lives in another context and that context
 *                         is not running — an MV3 extension whose engine tab is
 *                         closed. Open it and retry.
 *   TRANSPORT             the message channel failed, not the model — a port
 *                         that died mid-request, a payload that would not
 *                         structured-clone. Retryable; the model is fine.
 *
 * `TRANSPORT` exists because the alternative was actively misleading. Every
 * failure crossing the adapter boundary used to fall back to
 * `GENERATION_FAILED`, which a UI is entitled to read as "the model broke" — so
 * a disconnected port told the user their model had failed and invited them to
 * reload a gigabyte that was never the problem. The two codes want opposite
 * responses: retry the message, versus stop and investigate the model.
 *
 * `NO_ENGINE_HOST` earns its own code rather than folding into `NO_MODEL`
 * because the caller's move is different and *recoverable*: not "register a
 * model" but "open the tab that holds one". Under MV3 the background page
 * cannot hold a multi-GB model (STATUS.md, "MV3 migration"), so this is the one
 * failure a correctly-built MV3 extension still hits in normal use — a UI that
 * cannot tell it apart would tell the user to re-register a model they already
 * have.
 *
 * `PACKAGE_INCOMPLETE` covers two causes with one code on purpose. They are
 * different sentences and `detail.cause` tells them apart, but no caller writes
 * a different `catch` branch for them: both mean "your build is wrong, the app
 * has not shipped yet", and both are fixed by editing config, not by handling
 * an error path. A second code would have grown the table a caller reads
 * without giving that caller anything new to do.
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
  PACKAGE_INCOMPLETE: "PACKAGE_INCOMPLETE",
  NO_ENGINE_HOST: "NO_ENGINE_HOST",
  TRANSPORT: "TRANSPORT",
};

/**
 * The values `detail.cause` takes, for the codes that carry one.
 *
 * `cause` is a second discriminator under a single code: the code says what the
 * caller should *do*, `cause` says which sentence explains why. It stayed a
 * bare string literal at four call sites for as long as it only decorated
 * `PACKAGE_INCOMPLETE`, where nobody branches on it. `NO_ENGINE_HOST` changed
 * that — there, `cause` separates the recoverable case ("open the engine tab")
 * from the one no user action fixes ("this browser has no API to open one"), so
 * a caller genuinely does read it. A value a caller reads is a value a typo can
 * break, and `"no-tab-api"` for `"no-tabs-api"` is invisible in a string
 * literal. Same reasoning as `ERROR` itself, applied one level down.
 */
export const CAUSE = {
  /** PACKAGE_INCOMPLETE: `vendor/` was never built. */
  VENDOR_BUNDLE_MISSING: "vendor-bundle-missing",
  /** PACKAGE_INCOMPLETE: the bundler did not emit a reachable decode worker. */
  WORKER_UNREACHABLE: "worker-unreachable",
  /** NO_ENGINE_HOST: no `chrome.offscreen`, so no offscreen host can exist. */
  NO_OFFSCREEN_API: "no-offscreen-api",
  /** NO_ENGINE_HOST: no `tabs` API, so no host tab can be opened. */
  NO_TABS_API: "no-tabs-api",
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
  const wrapped = new EngineError(fallback, message);
  // Keep the original reachable. Under MV3 the background is evicted and rebuilt
  // constantly, so a rewritten message with no stack leaves nothing that points
  // back at the throw site. `cause` is the standard Error field for exactly this
  // and does not disturb `toJSON()`, which only serialises `detail`.
  if (err instanceof Error) wrapped.cause = err;
  return wrapped;
}

export const isEngineError = (err, code) =>
  err instanceof EngineError && (code === undefined || err.code === code);
