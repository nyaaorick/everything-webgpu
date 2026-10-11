/**
 * Adaptive WebExtension host management.
 *
 * Provides environment detection and host lifecycle management across browsers:
 * - Chrome: Launches an invisible Offscreen Document (`chrome.offscreen`).
 * - Firefox: Launches a hidden tab (`browser.tabs.hide`) or pinned tab fallback.
 *
 * Keeps host tabs off the user's active viewport whenever the platform permits.
 */
import { HOST_WAKE, PROTOCOL } from "./protocol.js";
import { CAUSE, ERROR, EngineError } from "../engine/errors.js";

/**
 * Where the engine host runs. `"auto"` picks the least intrusive one this
 * browser actually supports; the rest force a choice.
 *
 * Declared once and referenced everywhere (including `attachWebExtensionRelay`'s
 * `mode` option) so the list cannot drift between the file that resolves it and
 * the files that document it.
 *
 * @typedef {"auto" | "offscreen" | "hidden-tab" | "pinned-tab" | "tab"} HostMode
 */

/**
 * A `HostMode` with the choosing done — what `resolveMode` returns and what the
 * `ensure*` functions dispatch on.
 *
 * @typedef {Exclude<HostMode, "auto">} ResolvedHostMode
 */

/** The runtime half of `HostMode`, so an unknown mode can be refused by name. */
const HOST_MODES = /** @type {const} */ ([
  "auto",
  "offscreen",
  "hidden-tab",
  "pinned-tab",
  "tab",
]);

/**
 * The two extension globals, each `undefined` where it does not exist.
 *
 * Deliberately **lazy functions, not captured consts**: which globals exist is
 * a property of the moment, not of module load. Tests assign and `delete`
 * `globalThis.browser` / `globalThis.chrome` per case, and a value captured at
 * import time would answer for whichever browser the first test simulated.
 *
 * They stay separate because the distinction is load-bearing, not incidental:
 * `offscreen` is Chrome-only and `getBrowserInfo` is Firefox-only, so a single
 * merged accessor could not tell the two platforms apart.
 */
const getBrowser = () => (typeof browser !== "undefined" ? browser : undefined);
const getChrome = () => (typeof chrome !== "undefined" ? chrome : undefined);

/** Whichever runtime this context has — they are equivalent for messaging. */
const getRuntime = () => getBrowser()?.runtime ?? getChrome()?.runtime;

/** Whichever tabs API this context has. */
const getTabs = () => getBrowser()?.tabs ?? getChrome()?.tabs;

/**
 * Detect runtime browser environment and capabilities.
 *
 * @returns {{
 *   isChrome: boolean,
 *   isFirefox: boolean,
 *   hasOffscreen: boolean,
 *   hasTabHide: boolean,
 *   hasTabs: boolean
 * }}
 */
export function detectEnvironment() {
  const isFirefox = Boolean(getBrowser()?.runtime?.getBrowserInfo);
  const isChrome = !isFirefox && Boolean(getChrome()?.runtime);
  const hasOffscreen = Boolean(getChrome()?.offscreen?.createDocument);
  const hasTabHide = Boolean(getBrowser()?.tabs?.hide);
  const hasTabs = Boolean(getBrowser()?.tabs?.create || getChrome()?.tabs?.create);

  return { isChrome, isFirefox, hasOffscreen, hasTabHide, hasTabs };
}

/**
 * Resolve effective host mode based on capabilities and preferences.
 *
 * An unrecognised mode is refused rather than passed through. It used to reach
 * `ensureTabHost`, which reads any unknown string as `"tab"` — so a typo
 * (`"hidden_tab"`) silently produced the one behaviour the caller was trying to
 * avoid: a visible tab that steals focus.
 *
 * @param {HostMode} requestedMode
 * @param {ReturnType<typeof detectEnvironment>} env
 * @returns {ResolvedHostMode}
 */
function resolveMode(requestedMode, env) {
  if (!HOST_MODES.includes(requestedMode)) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `Unknown host mode "${requestedMode}". Expected one of: ${HOST_MODES.join(", ")}.`,
      { mode: requestedMode, expected: HOST_MODES },
    );
  }
  if (requestedMode !== "auto") return requestedMode;
  if (env.hasOffscreen) return "offscreen";
  // `hasTabHide` is only true when the `tabHide` permission is actually granted
  // — Firefox does not expose `browser.tabs.hide` without it. An extension that
  // does not request `tabHide` (in `permissions` or via `permissions.request`)
  // therefore falls through to `pinned-tab` here, which is the intended
  // graceful degradation, not a bug.
  if (env.hasTabHide) return "hidden-tab";
  if (env.hasTabs) return "pinned-tab";
  return "tab";
}

/**
 * Ping an existing host to see if it is already alive and answering.
 *
 * @returns {Promise<boolean>}
 */
async function pingHost() {
  const runtime = getRuntime();
  if (!runtime?.sendMessage) return false;
  try {
    const res = await runtime.sendMessage({ protocol: PROTOCOL, op: HOST_WAKE });
    return res?.ok === true;
  } catch {
    return false;
  }
}

/**
 * Ensure an offscreen document exists in Chrome.
 *
 * @param {string} hostUrl
 * @param {string} reason
 */
async function ensureOffscreenHost(hostUrl, reason) {
  const offscreen = getChrome()?.offscreen;
  if (!offscreen) {
    // Same family as an evicted engine tab — the engine host is not running and
    // nothing here can start one — so it reuses `NO_ENGINE_HOST` rather than
    // growing the error table. `detail.cause` records why the usual recovery
    // ("open the tab") does not apply: this platform has no API to open one.
    throw new EngineError(
      ERROR.NO_ENGINE_HOST,
      "chrome.offscreen is not available in this browser; no engine host can be opened.",
      { cause: CAUSE.NO_OFFSCREEN_API },
    );
  }
  // Creating a second document throws "Only a single offscreen document may be
  // created", so an existing one is the success case, not a conflict.
  if (typeof offscreen.hasDocument === "function") {
    const hasDoc = await offscreen.hasDocument();
    if (hasDoc) return;
  }
  const offscreenReason = offscreen.Reason?.WORKERS ?? "WORKERS";
  await offscreen.createDocument({
    url: hostUrl,
    reasons: [offscreenReason],
    justification: reason,
  });
}

/**
 * Ensure a tab-based host exists in Firefox or Chrome fallback.
 *
 * @param {string} hostUrl
 * @param {Exclude<ResolvedHostMode, "offscreen">} mode
 */
async function ensureTabHost(hostUrl, mode) {
  const tabs = getTabs();
  if (!tabs?.create) {
    throw new EngineError(
      ERROR.NO_ENGINE_HOST,
      "The tabs API is not available; no engine host tab can be opened.",
      { cause: CAUSE.NO_TABS_API },
    );
  }
  const matches = (await tabs.query({ url: hostUrl })) ?? [];
  if (matches.length > 1) {
    console.warn(
      `[Everything WebGPU] ${matches.length} engine host tabs are open; each holds its own model.`,
    );
  }
  const existing = matches[0];
  if (existing) {
    // **A discarded tab is not a host.** Firefox unloads background tabs
    // aggressively, and a pinned, hidden, never-looked-at one is a prime
    // candidate. Its JS is gone, so `pingHost` got no answer — but the tab is
    // still in `tabs.query`, so returning here would report success, leave the
    // relay waiting out its full `timeoutMs`, and then tell the user to open an
    // engine tab that is sitting right there. Reloading revives it in place.
    if (existing.discarded) {
      await tabs.reload?.(existing.id);
      return;
    }
    if (mode === "tab") await tabs.update(existing.id, { active: true });
    return;
  }
  const isPinned = mode === "pinned-tab" || mode === "hidden-tab";
  const created = await tabs.create({ url: hostUrl, active: mode === "tab", pinned: isPinned });
  if (mode === "hidden-tab" && typeof tabs.hide === "function") {
    try {
      await tabs.hide(created.id);
    } catch (err) {
      // Not a missing permission, despite what this comment used to claim:
      // `resolveMode` only yields "hidden-tab" when `browser.tabs.hide` exists,
      // and Firefox exposes it only once `tabHide` is granted. So a throw here
      // is the real thing — an invalid id, or Firefox declining to hide this
      // tab. The pinned tab stays as a working fallback, but it stays *visible*,
      // which is exactly the outcome the caller asked to avoid; say so rather
      // than leaving a mystery pinned tab with no explanation.
      console.warn("[Everything WebGPU] could not hide the engine host tab:", err);
    }
  }
}

/**
 * Creates an adaptive host controller to wake and manage the engine host.
 *
 * @param {object} opts
 * @param {string} opts.hostUrl **Full** extension URL of the host page, as
 *   `browser.runtime.getURL("src/host/host.html")` returns. Not a relative
 *   path: it goes to `tabs.query({url})` and `offscreen.createDocument({url})`,
 *   which both need an absolute, resolvable URL.
 * @param {HostMode} [opts.mode="auto"]
 * @param {string} [opts.reason="WebGPU LLM engine host"] justification for offscreen creation
 * @returns {{
 *   wakeHost: () => Promise<void>,
 *   getResolvedMode: () => ResolvedHostMode
 * }}
 */
export function createHostController({ hostUrl, mode = "auto", reason = "WebGPU LLM engine host" }) {
  if (!hostUrl) {
    throw new EngineError(ERROR.BAD_REQUEST, "hostUrl is required for host controller.");
  }
  const env = detectEnvironment();
  const resolvedMode = resolveMode(mode, env);

  const wakeHost = async () => {
    const answered = await pingHost();
    if (answered) return;

    if (resolvedMode === "offscreen") {
      await ensureOffscreenHost(hostUrl, reason);
    } else {
      await ensureTabHost(hostUrl, resolvedMode);
    }
  };

  return {
    wakeHost,
    getResolvedMode: () => resolvedMode,
  };
}
