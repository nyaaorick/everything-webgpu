/**
 * What `load()` was handed, decided before anything touches the network.
 *
 * `load` absorbs `registerModel` and `ingestModelFolder`, so one call has to
 * tell four things apart: a model id, a URL to fetch from, an explicit remote
 * spec, and a folder off disk. Keeping that decision here — pure, synchronous,
 * no store and no engine — means it can be tested exhaustively without a GPU,
 * and means `load()` reads as "classify, then act".
 *
 * Two rules this deliberately does **not** implement, both measured rather than
 * assumed:
 *
 *  - **`modelLib` is never guessed.** `<base><id>-webgpu.wasm` matches 0 of the
 *    163 prebuilt models (real names carry a `_cs1k`-style suffix and drop the
 *    `-MLC`), and 0 of 163 host the lib on the same origin as the weights —
 *    they live on `raw.githubusercontent.com`. A guess would be wrong every
 *    time and would surface as a 404 deep inside WebLLM's loader, which is the
 *    worst place to learn it. So a URL source without `modelLib` fails here,
 *    immediately, with a sentence saying why.
 *  - **`/resolve/main/` is never derived for HuggingFace URLs.** WebLLM's
 *    `cleanModelUrl` already appends it when the URL does not match
 *    `.+/resolve/.+/`. Deriving it here would re-introduce exactly the
 *    duplication ARCHIVE.md records removing. The URL is passed through.
 */
import { ERROR, EngineError } from "./errors.js";

/** @typedef {"id"|"remote"|"register"|"files"} SourceKind */

export const SOURCE_KIND = {
  ID: "id",
  REMOTE: "remote",
  REGISTER: "register",
  FILES: "files",
};

/** A scheme, as `absolutize()` recognises one. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/**
 * A string is a location rather than an id when it carries a scheme or is
 * explicitly path-shaped. No prebuilt model id contains `/` or `:`, so this
 * never steals a real id — and it means `load("/models/foo/")` is understood
 * as the URL it obviously is instead of being looked up and reported missing.
 */
export const looksLikeUrl = (s) =>
  HAS_SCHEME.test(s) || s.startsWith("/") || s.startsWith("./") || s.startsWith("../");

/** Duck-typed: `DataTransfer` and `FileList` do not exist in Node. */
export const isDataTransfer = (v) => !!v && typeof v === "object" && "items" in v && "files" in v;
export const isFileList = (v) =>
  !!v &&
  typeof v === "object" &&
  typeof v.length === "number" &&
  !Array.isArray(v) &&
  (v.length === 0 || typeof v[0]?.name === "string");

/**
 * The local label for a model loaded from a URL.
 *
 * Safe to derive, unlike `modelLib`: an id is a key in our own registry, never
 * a path anything fetches, so a wrong guess is visible immediately and costs
 * nothing. `.../mlc-ai/Foo-MLC` and `.../models/foo/` both give the last real
 * segment.
 */
export function idFromUrl(url) {
  const path = HAS_SCHEME.test(url) ? safeUrlPath(url) : url;
  const segments = path.split("/").filter((s) => s && s !== "." && s !== "..");
  const last = segments.at(-1);
  return last ? decodeURIComponent(last) : null;
}

function safeUrlPath(url) {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

/**
 * @param {string | object} src
 * @param {{id?: string, modelLib?: string}} [opts]
 * @returns {{kind: SourceKind, modelId?: string, model?: string, modelLib?: string, files?: unknown}}
 */
export function classifySource(src, opts = {}) {
  if (src === null || src === undefined || src === "") {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      "load() needs a model id, a URL, `{ model, modelLib }`, or a folder " +
        "(`{ files }`, a FileList, or a drop event's DataTransfer).",
    );
  }

  if (typeof src === "string") {
    if (!looksLikeUrl(src)) return { kind: SOURCE_KIND.ID, modelId: src };
    return remote(src, opts.modelLib, opts.id ?? idFromUrl(src));
  }

  // Folder routes first: a DataTransfer also has other properties, and `files`
  // is the field that decides, exactly as `registerModel` already reads it.
  if (isDataTransfer(src) || isFileList(src) || Array.isArray(src)) {
    return { kind: SOURCE_KIND.FILES, files: src, modelId: opts.id };
  }

  if (typeof src === "object") {
    if (src.files !== undefined) {
      if (src.model || src.modelLib) {
        throw new EngineError(
          ERROR.BAD_REQUEST,
          "load() takes either `files` (local, never fetched) or `model`/`modelLib` " +
            "(a base URL to fetch), not both.",
        );
      }
      return { kind: SOURCE_KIND.FILES, files: src.files, modelId: src.modelId ?? opts.id };
    }
    if (src.model !== undefined) {
      // The id falls back to the URL exactly as the string form's does — the
      // two spellings of "a model at this URL" must not disagree about it.
      const spec = remote(
        src.model,
        src.modelLib ?? opts.modelLib,
        src.modelId ?? opts.id ?? idFromUrl(String(src.model)),
      );
      return { ...spec, kind: SOURCE_KIND.REGISTER };
    }
  }

  throw new EngineError(
    ERROR.BAD_REQUEST,
    "load() did not recognise that source. Pass a model id, a URL, " +
      "`{ model, modelLib }`, or a folder (`{ files }`, a FileList, or a DataTransfer).",
    { received: typeof src },
  );
}

/** The one place a URL source is validated, so both string and object forms agree. */
function remote(model, modelLib, modelId) {
  if (!modelLib) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `Loading "${model}" from a URL needs \`modelLib\` — the compiled .wasm — and it cannot be ` +
        "guessed: across all 163 prebuilt models, none has a lib name derivable from its id and " +
        "none hosts the lib on the same origin as the weights. " +
        "Pass load(url, { modelLib: \"https://.../foo-webgpu.wasm\" }).",
      { model },
    );
  }
  if (!modelId) {
    throw new EngineError(
      ERROR.BAD_REQUEST,
      `Could not derive a model id from "${model}". Pass one as load(src, { id }).`,
      { model },
    );
  }
  return { kind: SOURCE_KIND.REMOTE, model, modelLib, modelId };
}

/**
 * Ids close enough to be a typo, so an unknown id can say "did you mean".
 *
 * Cheap on purpose — case-insensitive substring both ways, then a bounded edit
 * distance. The list is at most a few hundred entries and this runs once, on a
 * path that is already about to throw.
 */
export function nearMatches(wanted, available, limit = 3) {
  const needle = wanted.toLowerCase();
  const scored = available
    .map((id) => {
      const hay = id.toLowerCase();
      if (hay === needle) return { id, score: 0 };
      if (hay.includes(needle) || needle.includes(hay)) return { id, score: 1 };
      return { id, score: 2 + editDistance(needle, hay) };
    })
    // Beyond this a "suggestion" is noise, and a wrong suggestion is worse than
    // none — it sends the reader looking for a model that was never the point.
    .filter(({ score, id }) => score <= 2 + Math.ceil(Math.max(id.length, needle.length) / 3))
    .sort((a, b) => a.score - b.score || a.id.localeCompare(b.id));

  return scored.slice(0, limit).map(({ id }) => id);
}

/** Levenshtein, two rows. */
function editDistance(a, b) {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(
        prev[j] + 1,
        row[j - 1] + 1,
        prev[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
    }
    prev = row;
  }
  return prev[b.length];
}
