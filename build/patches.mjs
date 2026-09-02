/**
 * The two rewrites applied to the bundled WebLLM, as data plus one applier.
 *
 * They used to be two functions that each did their own `includes()` check and
 * threw a sentence. That was fine while they worked and useless the moment they
 * did not: a version bump reported "anchor did not match" and left you grepping
 * a 6 MB file for where the code went.
 *
 * Declarative anchors buy three things a pair of ad-hoc functions could not:
 *
 *  - **Verify before writing.** Every anchor in every patch is checked first, so
 *    a bump reports *all* the breakage at once instead of the first failure.
 *  - **Re-anchoring in minutes.** A miss prints the anchor's distinctive
 *    identifiers and the lines where they now live, ranked. That is usually
 *    enough to see what upstream renamed or moved.
 *  - **A version record.** `patch-manifest.json` remembers which WebLLM these
 *    anchors were verified against, so the build can say "checking 5 anchors
 *    against 0.2.85, previously verified against 0.2.84" rather than silently
 *    succeeding and leaving you unsure whether it checked anything.
 *
 * What this does *not* do is re-anchor itself. A rename still needs a human to
 * approve the new anchor — but it does not need one to *find* it: an upstream
 * rename of `requiredMaxStorageBuffersPerShaderStage` to
 * `…PerStage` is reported as an 85%-similar identifier with its line and source,
 * which was the difference between minutes and an afternoon.
 *
 * Two things widen what counts as a match, and it is worth being precise about
 * what each one actually survives — the earlier plan overstated both.
 *
 *  - **Anchors match modulo whitespace.** An anchor is written as literal JS and
 *    compiled to a pattern that tolerates reflowing: a line break inside
 *    `submit([…])`, a space before `;`. It does **not** survive a rename, and
 *    neither would an AST search by name — that is the same identifier either
 *    way. Since we control minification (`--minify`, off) and the bundle's
 *    formatting is upstream's published JS, this is the *less* likely drift; it
 *    costs nothing, so it is on for every anchor.
 *  - **An anchor can be scoped to an enclosing function** (`in`). This is the
 *    one that pays. `compute.end();` is a generic string, and requiring it to be
 *    unique in 6 MB means any unrelated new `compute.end();` anywhere in tvmjs
 *    fails the build for no reason. Scoped to the function that contains the
 *    `beginComputePass()` anchor, that whole class of false failure is gone —
 *    and the scope is derived from a *matched anchor*, not a function name, so
 *    it adds no new identifier that upstream could rename out from under us.
 */

import { parse } from "acorn";

/** Cap so one compute pass can never grow unbounded; 41/flush is the measured norm. */
export const MAX_DISPATCHES_PER_PASS = 1024;

/**
 * @typedef {object} Edit
 * @property {string} before literal JS, matched modulo whitespace. Must appear
 *   exactly once in its search range — more than one match means the anchor
 *   stopped being unique and the rewrite could land in the wrong place
 * @property {string} after
 * @property {{enclosing: number}} [in] restrict the search to the function
 *   enclosing edit `enclosing`'s match, rather than the whole bundle
 *
 * @typedef {object} Patch
 * @property {string} id
 * @property {string} why  one line, shown when the patch is skipped or fails
 * @property {() => boolean} [skipWhen]
 * @property {Edit[]} edits
 */

/** @type {Patch[]} */
export const PATCHES = [
  {
    id: "storage-buffer-limit",
    why:
      "tvmjs hardcodes a request for 10 storage buffers per shader stage; Firefox's Metal backend " +
      "caps maxStorageBuffersPerShaderStage at 9, so detectGPUDevice() throws before a device is " +
      "ever requested. Clamping to what the adapter reports lets the device be created; kernels " +
      "that genuinely need the 10th binding still fail later, loudly, at pipeline creation.",
    edits: [
      {
        before: "const requiredMaxStorageBuffersPerShaderStage = 10;",
        after:
          "const requiredMaxStorageBuffersPerShaderStage = Math.min(10, adapter.limits.maxStorageBuffersPerShaderStage);",
      },
    ],
  },
  {
    id: "compute-pass-batching",
    why:
      "tvmjs opens a fresh compute pass per kernel launch. A pass costs ~100 us and a dispatch " +
      "inside one is free, while decode issues 664 kernels/token over only 16 flushes — so ~41 " +
      "consecutive launches were each paying for their own pass. Measured 10.3 -> 25.9 tok/s on " +
      "an identical greedy generation, byte-identical output.",
    skipWhen: () => Boolean(process.env.NO_PASS_MERGE),
    edits: [
      // Reuse the open pass instead of beginning one per launch.
      {
        before: "const compute = this.pendingEncoder.beginComputePass();",
        after:
          "if (!this.pendingComputePass) { this.pendingComputePass = this.pendingEncoder.beginComputePass(); } " +
          "const compute = this.pendingComputePass;",
      },
      // Do not end it per launch; only guard against an unbounded pass.
      //
      // Scoped to the shader-submit function the anchor above matched in.
      // `compute.end();` is generic enough that requiring it to be unique across
      // 6 MB makes the build hostage to unrelated tvmjs code: any new compute
      // pass anywhere else in the runtime would fail it. Inside that one
      // function it is unambiguous, which is the only place uniqueness is
      // load-bearing.
      {
        before: "compute.end();",
        in: { enclosing: 0 },
        after: `if (this.pendingDispatchCount >= ${MAX_DISPATCHES_PER_PASS}) this.flushCommands();`,
      },
      // Close it exactly where the encoder is submitted.
      {
        before: "this.device.queue.submit([this.pendingEncoder.finish()]);",
        after:
          "if (this.pendingComputePass) { this.pendingComputePass.end(); this.pendingComputePass = null; } " +
          "this.device.queue.submit([this.pendingEncoder.finish()]);",
      },
    ],
  },
];

// ------------------------------------------------------------- matching ----

const escape = (c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const isWord = (c) => /[\w$]/.test(c);

/**
 * Compile a literal-JS anchor into a whitespace-tolerant pattern.
 *
 * Between two word characters whitespace is significant — `const x` cannot
 * become `constx` — so a gap there stays required. Everywhere a punctuation
 * character is involved, whitespace becomes optional in both directions, which
 * is what makes `submit([this.pendingEncoder.finish()]);` survive being reflowed
 * across three lines, or `= 10;` survive `= 10 ;`.
 *
 * The ends are word-bounded, for the reason the contract test's member check
 * was: a plain substring search for `compute.end();` also matches
 * `precompute.end();`, and a second "match" that is not one fails the build just
 * as hard as a real ambiguity.
 */
export function anchorPattern(anchor) {
  const chars = [...anchor.trim()];
  let out = isWord(chars[0]) ? "(?<![\\w$])" : "";
  for (let i = 0; i < chars.length; i++) {
    out += escape(chars[i]);
    let j = i + 1;
    while (j < chars.length && /\s/.test(chars[j])) j += 1;
    if (j >= chars.length) break;
    const gap = j > i + 1;
    if (isWord(chars[i]) && isWord(chars[j])) out += gap ? "\\s+" : "";
    else out += "\\s*";
    i = j - 1;
  }
  return isWord(chars.at(-1)) ? `${out}(?![\\w$])` : out;
}

/** Every match of a compiled anchor that lies wholly inside `[from, to)`. */
function matchesIn(pattern, source, from = 0, to = source.length) {
  const re = new RegExp(pattern, "g");
  re.lastIndex = from;
  const found = [];
  for (let m = re.exec(source); m; m = re.exec(source)) {
    if (m.index >= to) break;
    if (m.index + m[0].length <= to) found.push({ start: m.index, end: m.index + m[0].length });
    re.lastIndex = m.index + Math.max(1, m[0].length);
  }
  return found;
}

// -------------------------------------------------------------- scoping ----

const FUNCTIONS = new Set([
  "FunctionDeclaration",
  "FunctionExpression",
  "ArrowFunctionExpression",
]);

/** Parsing 6 MB costs ~1 s, and a build asks for at most one scope per edit. */
let parsed = { source: null, ast: null };

function ast(source) {
  if (parsed.source !== source) {
    parsed = { source, ast: parse(source, { ecmaVersion: "latest", sourceType: "module" }) };
  }
  return parsed.ast;
}

/** The name the nearest enclosing binding gives a function, for reporting. */
function nameOf(node) {
  if (node.type === "FunctionDeclaration" || node.type === "ClassDeclaration") return node.id?.name;
  if (node.type === "VariableDeclarator") return node.id?.name;
  if (node.type === "MethodDefinition" || node.type === "Property") {
    return node.key?.name ?? node.key?.value;
  }
  return undefined;
}

/**
 * The innermost function containing `offset`.
 *
 * A generic descent rather than `acorn-walk`: the only question is containment,
 * and pruning on it makes the walk proportional to nesting depth instead of to
 * the size of the file.
 */
function enclosingFunction(source, offset) {
  let best = null;
  let bestName;
  const visit = (node, name) => {
    if (node.start > offset || node.end <= offset) return;
    const named = nameOf(node) ?? name;
    if (FUNCTIONS.has(node.type)) {
      best = node;
      bestName = named;
    }
    for (const key of Object.keys(node)) {
      const value = node[key];
      if (Array.isArray(value)) {
        for (const child of value) if (child?.type) visit(child, named);
      } else if (value?.type) {
        visit(value, named);
      }
    }
  };
  visit(ast(source), undefined);
  return best && { start: best.start, end: best.end, name: bestName ?? "(anonymous)" };
}

const lineOf = (source, offset) => source.slice(0, offset).split("\n").length;

/** Words that carry no locating power; `const` matches half the file. */
const NOISE = new Set(
  ("const let var this function return await async class new typeof void null true false " +
   "else this0 case break continue export import default from").split(" "),
);

const identifiers = (text) => (text.match(/[A-Za-z_$][\w$]{3,}/g) ?? []).filter((w) => !NOISE.has(w));

const trigrams = (w) => {
  const s = new Set();
  const lower = w.toLowerCase();
  for (let i = 0; i < lower.length - 2; i++) s.add(lower.slice(i, i + 3));
  return s;
};

function similarity(a, b) {
  const A = trigrams(a);
  const B = trigrams(b);
  if (A.size === 0 || B.size === 0) return 0;
  let shared = 0;
  for (const t of A) if (B.has(t)) shared += 1;
  return shared / (A.size + B.size - shared);
}

/**
 * Where an anchor's distinctive words went.
 *
 * Two questions, because a broken anchor is usually one of two things.
 *
 * **"Was something renamed?"** For each identifier that has vanished entirely,
 * the closest surviving identifier by trigram overlap. This is the one that
 * pays: `requiredMaxStorageBuffersPerShaderStage` ->
 * `requiredMaxStorageBuffersPerStage` scores ~0.9 and lands on the exact line.
 *
 * **"Where did the call site move?"** Lines ranked by the summed rarity of the
 * anchor's identifiers, so a word appearing 8000 times contributes almost
 * nothing and one appearing three times dominates. Ranking by raw hit count
 * instead returned `const msg = {` — literally true, useless.
 */
function locate(anchor, source, limit = 3) {
  const words = [...new Set(identifiers(anchor))];
  if (words.length === 0) return { renamed: [], lines: [] };

  const lines = source.split("\n");
  const freq = new Map(words.map((w) => [w, source.split(w).length - 1]));

  // Vanished identifiers: look for what replaced them.
  const renamed = [];
  const vanished = words.filter((w) => freq.get(w) === 0);
  if (vanished.length) {
    const all = new Set(identifiers(source));
    for (const gone of vanished) {
      const near = [...all]
        .map((cand) => ({ name: cand, score: similarity(gone, cand) }))
        .filter((c) => c.score > 0.45)
        .sort((a, b) => b.score - a.score)
        .slice(0, 2);
      for (const c of near) {
        const at = lines.findIndex((l) => l.includes(c.name));
        renamed.push({ gone, now: c.name, score: c.score, line: at + 1, text: lines[at]?.trim() ?? "" });
      }
    }
  }

  // Surviving identifiers: rank lines by rarity, not by hit count.
  const weight = (w) => {
    const n = freq.get(w) ?? 0;
    return n === 0 ? 0 : 1 / Math.log2(n + 2);
  };
  const scored = [];
  for (let i = 0; i < lines.length; i++) {
    let score = 0;
    let hits = 0;
    for (const w of words) {
      if (lines[i].includes(w)) {
        score += weight(w);
        hits += 1;
      }
    }
    if (score > 0) scored.push({ line: i + 1, hits, score, text: lines[i].trim() });
  }
  scored.sort((a, b) => b.score - a.score || a.text.length - b.text.length);

  return { renamed, lines: scored.slice(0, limit).map((s) => ({ ...s, of: words.length })) };
}

/**
 * Checks every anchor of every applicable patch without writing anything, and
 * returns where each one matched.
 *
 * The offsets are the point: the caller rewrites by splicing them, so an anchor
 * is located exactly once and the text that gets replaced is the text that was
 * verified. (It also means a `$&` in a replacement is inert, which
 * `String.replace` would have expanded.)
 *
 * @returns {{ok: boolean, applicable: Patch[], failures: Array<object>,
 *            plan: Array<{patch: string, start: number, end: number, after: string}>}}
 */
export function verifyPatches(source) {
  const applicable = PATCHES.filter((p) => !p.skipWhen?.());
  const failures = [];
  const plan = [];

  for (const patch of applicable) {
    /** Resolved matches by edit index, so a later edit can scope to an earlier one. */
    const resolved = [];

    for (const [index, edit] of patch.edits.entries()) {
      const fail = (extra) =>
        failures.push({ patch: patch.id, why: patch.why, index, anchor: edit.before, ...extra });

      let scope = null;
      if (edit.in) {
        const host = resolved[edit.in.enclosing];
        if (!host) {
          // Its scope comes from an anchor that did not match. Reporting this as
          // a second missing anchor would send the reader looking for two
          // problems; there is one.
          fail({ matches: null, blockedBy: edit.in.enclosing });
          continue;
        }
        scope = enclosingFunction(source, host.start);
        if (!scope) {
          fail({ matches: null, noScope: true });
          continue;
        }
      }

      const found = matchesIn(
        anchorPattern(edit.before),
        source,
        scope?.start ?? 0,
        scope?.end ?? source.length,
      );
      if (found.length !== 1) {
        fail({
          matches: found.length,
          scope: scope && { ...scope, line: lineOf(source, scope.start) },
          // Only search the whole file for where it went; a scoped miss is far
          // more likely to be the scope having moved than the anchor's words
          // having vanished, and the global view shows both.
          candidates: found.length === 0 ? locate(edit.before, source) : null,
        });
        continue;
      }
      resolved[index] = found[0];
      plan.push({ patch: patch.id, start: found[0].start, end: found[0].end, after: edit.after });
    }
  }

  // Descending, so splicing one edit cannot invalidate the offsets of the next.
  plan.sort((a, b) => b.start - a.start);
  return { ok: failures.length === 0, applicable, failures, plan };
}

/** Human-readable report for a failed verification. */
export function explainFailures(failures) {
  const out = [];
  for (const f of failures) {
    out.push("");
    if (f.blockedBy !== undefined) {
      out.push(`  ✗ ${f.patch} [anchor ${f.index + 1}] — not checked`);
      out.push(`    looking for: ${f.anchor}`);
      out.push(
        `    it is scoped to the function anchor ${f.blockedBy + 1} matched in, and that anchor`,
      );
      out.push("    did not match. Fix that one first; this may well follow it.");
      continue;
    }
    if (f.noScope) {
      out.push(`  ✗ ${f.patch} [anchor ${f.index + 1}] — scope not found`);
      out.push(`    looking for: ${f.anchor}`);
      out.push("    the anchor it scopes to now matches at top level, not inside a function.");
      out.push("    Upstream restructured this area; re-read it before re-anchoring.");
      continue;
    }
    const where = f.scope ? ` in ${f.scope.name}() (line ${f.scope.line})` : "";
    out.push(
      `  ✗ ${f.patch} [anchor ${f.index + 1}] — ${f.matches} matches${where}, expected exactly 1`,
    );
    out.push(`    looking for: ${f.anchor}`);
    if (f.matches > 1) {
      // Not a missing anchor but an ambiguous one. Rewriting on any of them
      // could land in the wrong place, so this is a hard stop too.
      out.push(`    the anchor is no longer unique — ${f.matches} sites match, so the rewrite is unsafe.`);
      out.push("    narrow it with more surrounding context before re-running.");
    } else if (f.candidates?.renamed.length || f.candidates?.lines.length) {
      for (const r of f.candidates.renamed) {
        out.push(`    likely renamed: ${r.gone}`);
        out.push(`                 -> ${r.now}  (${Math.round(r.score * 100)}% similar, line ${r.line})`);
        if (r.text) out.push(`                    ${truncate(r.text, 100)}`);
      }
      if (f.candidates.lines.length) {
        out.push("    nearest lines by identifier rarity:");
        for (const c of f.candidates.lines) {
          out.push(`      line ${c.line} (${c.hits}/${c.of}): ${truncate(c.text, 100)}`);
        }
      }
    } else {
      out.push("    no line in the bundle contains any of its identifiers — the code was removed,");
      out.push("    or renamed wholesale. Check the WebLLM changelog for this area.");
    }
    out.push(`    why this patch exists: ${wrap(f.why, 6)}`);
  }
  return out.join("\n");
}

const truncate = (s, n) => (s.length <= n ? s : `${s.slice(0, n - 1)}…`);

function wrap(text, indent) {
  const width = 88;
  const pad = " ".repeat(indent);
  const words = text.split(/\s+/);
  const lines = [[]];
  let len = 0;
  for (const w of words) {
    if (len + w.length > width && lines.at(-1).length) {
      lines.push([]);
      len = 0;
    }
    lines.at(-1).push(w);
    len += w.length + 1;
  }
  return lines.map((l) => l.join(" ")).join(`\n${pad}`);
}
