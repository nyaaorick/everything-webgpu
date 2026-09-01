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
 */

/** Cap so one compute pass can never grow unbounded; 41/flush is the measured norm. */
export const MAX_DISPATCHES_PER_PASS = 1024;

/**
 * @typedef {object} Patch
 * @property {string} id
 * @property {string} why  one line, shown when the patch is skipped or fails
 * @property {Array<{before: string, after: string}>} edits each `before` must
 *   appear exactly once — more than one match means the anchor stopped being
 *   unique and the rewrite could land in the wrong place
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
      {
        before: "compute.end();",
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
 * Checks every anchor of every applicable patch without writing anything.
 * @returns {{ok: boolean, applicable: Patch[], failures: Array<object>}}
 */
export function verifyPatches(source) {
  const applicable = PATCHES.filter((p) => !p.skipWhen?.());
  const failures = [];

  for (const patch of applicable) {
    for (const [index, edit] of patch.edits.entries()) {
      const matches = source.split(edit.before).length - 1;
      if (matches !== 1) {
        failures.push({
          patch: patch.id,
          why: patch.why,
          index,
          anchor: edit.before,
          matches,
          candidates: matches === 0 ? locate(edit.before, source) : null,
        });
      }
    }
  }
  return { ok: failures.length === 0, applicable, failures };
}

/** Human-readable report for a failed verification. */
export function explainFailures(failures) {
  const out = [];
  for (const f of failures) {
    out.push("");
    out.push(`  ✗ ${f.patch} [anchor ${f.index + 1}] — ${f.matches} matches, expected exactly 1`);
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
