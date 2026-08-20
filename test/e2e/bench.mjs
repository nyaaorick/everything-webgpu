/**
 * WebGPU submit/sync round-trip benchmark, no extension and no model involved.
 *
 * Exists because decode throughput turned out to be bounded entirely by one
 * GPU sync per token. This isolates that sync in a plain https-equivalent page
 * (127.0.0.1 counts as a secure context) so it can be compared against the same
 * numbers measured inside the extension.
 *
 *   node test/e2e/bench.mjs
 */
import { spawn } from "node:child_process";
import { createServer } from "node:http";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const PORT = 8788;
const FIREFOX = process.env.FIREFOX ?? "/Applications/Firefox.app/Contents/MacOS/firefox";
const HERE = import.meta.dirname;

const PAGE = `<!DOCTYPE html><meta charset="utf-8"><title>webgpu bench</title>
<body><pre id="out">running…</pre><script type="module">
import { gpuBench } from "./gpubench.js";
const out = document.getElementById("out");
try {
  const bench = await gpuBench();
  out.textContent = JSON.stringify(bench, null, 2);
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ where: "plain page (normal tab)", bench }) });
} catch (err) {
  out.textContent = String(err);
  await fetch("/report", { method: "POST", headers: { "content-type": "application/json" },
    body: JSON.stringify({ where: "plain page (normal tab)", error: String(err) }) });
}
</script>`;

let done;
const report = new Promise((res) => (done = res));

const server = createServer((req, res) => {
  if (req.url === "/" || req.url === "/bench.html") {
    res.writeHead(200, { "content-type": "text/html" });
    return res.end(PAGE);
  }
  if (req.url === "/gpubench.js") {
    res.writeHead(200, { "content-type": "text/javascript" });
    return res.end(readFileSync(join(HERE, "page/gpubench.js")));
  }
  if (req.method === "POST" && req.url === "/report") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      res.writeHead(204).end();
      done(JSON.parse(body));
    });
    return;
  }
  res.writeHead(404).end();
});

await new Promise((r) => server.listen(PORT, "127.0.0.1", r));

const profile = mkdtempSync(join(tmpdir(), "ewgpu-bench-"));
writeFileSync(join(profile, "user.js"), [
  'user_pref("dom.webgpu.enabled", true);',
  'user_pref("gfx.webgpu.ignore-blocklist", true);',
  'user_pref("browser.shell.checkDefaultBrowser", false);',
  'user_pref("datareporting.policy.dataSubmissionEnabled", false);',
].join("\n"));

const firefox = spawn(FIREFOX, ["--profile", profile, "--no-remote", `http://127.0.0.1:${PORT}/bench.html`], {
  stdio: "ignore",
});

const result = await Promise.race([
  report,
  new Promise((_, rej) => setTimeout(() => rej(new Error("timed out")), 90_000)),
]).catch((e) => ({ error: e.message }));

firefox.kill("SIGTERM");
server.close();

console.log(`\n${result.where ?? "plain page"}:`);
console.log(result.error ?? Object.entries(result.bench).map(([k, v]) => `  ${k} = ${v}`).join("\n"));
process.exit(result.error ? 1 : 0);
