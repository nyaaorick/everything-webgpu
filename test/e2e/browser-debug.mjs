/** Visible Edge + Firefox verification against an installed npm tarball. */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync, writeFileSync, copyFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ROOT = resolve(import.meta.dirname, "../..");
const workPath = process.env.DEBUG_WORK ? resolve(process.env.DEBUG_WORK) : mkdtempSync(join(tmpdir(), "ewgpu-debug-"));
mkdirSync(workPath, { recursive: true });
const WORK = realpathSync(workPath);
const jsonMode = process.env.JSON_OUTPUT === "1";
const uploadMode = process.env.UPLOAD_BENCH === "1";
const responsesMode = process.env.RESPONSES === "1" || uploadMode || jsonMode;
const ARTIFACTS = process.env.DEBUG_ARTIFACTS ? resolve(process.env.DEBUG_ARTIFACTS) : join(ROOT, jsonMode ? "artifacts/json-output" : uploadMode ? `artifacts/upload-${process.env.NO_UPLOAD_BATCHING ? "baseline" : "batched"}` : responsesMode ? "artifacts/responses-debug" : "artifacts/browser-debug");
const MODEL = (process.env.MODEL_DIR ?? join(homedir(), "Downloads/Qwen3.5-0.8B-q4f16_1-MLC")).replace(/^~/, homedir());
mkdirSync(WORK, { recursive: true });
mkdirSync(ARTIFACTS, { recursive: true });
const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const tgz = sh("npm", ["pack", "--pack-destination", WORK], ROOT).trim().split("\n").pop();
writeFileSync(join(WORK, "package.json"), JSON.stringify({ name: "ewgpu-debug", private: true, type: "module" }));
console.log("Installing isolated browser debug dependencies…");
sh("npm", ["install", join(WORK, tgz), "vite@6.4.4", "puppeteer-core@24.43.1", "@wllama/wllama@3.8.1", "zod@4.6.7"], WORK);
const installed = join(WORK, "node_modules/everything-webgpu");
const packageInfo = JSON.parse(readFileSync(join(installed, "package.json"), "utf8"));
const runtimeFiles = [
  ...readdirSync(join(installed, "src/engine")).filter((name) => name.endsWith(".js")).map((name) => `src/engine/${name}`),
  "vendor/web-llm.js", "vendor/worker.bundle.js", "vendor/worker-source.js",
].sort();
const runtimeHash = createHash("sha256").update(JSON.stringify(packageInfo.dependencies));
for (const name of runtimeFiles) runtimeHash.update(name).update(readFileSync(join(installed, name)));
const candidate = { version: packageInfo.version, sdk: packageInfo.dependencies.openai,
  tarballSHA256: createHash("sha256").update(readFileSync(join(WORK, tgz))).digest("hex"),
  runtimeSHA256: runtimeHash.digest("hex") };
copyFileSync(join(import.meta.dirname, jsonMode ? "json-page.js" : uploadMode ? "upload-page.js" : responsesMode ? "responses-page.js" : "debug-page.js"), join(WORK, "debug-page.js"));
writeFileSync(join(WORK, "index.html"), '<!doctype html><html lang="en"><meta charset="utf-8"><title>Everything WebGPU debug</title><body><h1>Edge / Firefox model verification</h1><pre style="white-space:pre-wrap"></pre><script type="module" src="/debug-page.js"></script></body></html>');
const gguf = join(WORK, "stories260K.gguf");
if (!responsesMode && !existsSync(gguf)) {
  console.log("Downloading the tiny CPU feasibility model…");
  sh("curl", ["-fL", "--retry", "2", "-o", gguf, "https://huggingface.co/ggml-org/models/resolve/main/tinyllamas/stories260K.gguf"], WORK);
}
const { createServer } = await import(pathToFileURL(join(WORK, "node_modules/vite/dist/node/index.js")));
const { default: puppeteer } = await import(pathToFileURL(join(WORK, "node_modules/puppeteer-core/lib/esm/puppeteer/puppeteer-core.js")));
const server = await createServer({
  root: WORK, configFile: false,
  plugins: [{ name: "ewgpu-debug",
    config: () => responsesMode ? {} : ({ optimizeDeps: { exclude: ["everything-webgpu", "@wllama/wllama"] } }),
    configureServer(s) {
      s.middlewares.use((req, res, next) => {
        const url = new URL(req.url, "http://localhost");
        let file;
        if (url.pathname.startsWith("/models/")) {
          const name = decodeURIComponent(url.pathname.slice(8)).replace(/^resolve\/main\//, "");
          if (!name || name.includes("/") || name.includes("..")) { res.statusCode = 400; return res.end(); }
          file = join(MODEL, name);
        } else if (url.pathname === "/cpu/stories260K.gguf") file = gguf;
        else if (url.pathname === "/cpu/wllama.wasm") file = join(WORK, "node_modules/@wllama/wllama/src/wasm/wllama.wasm");
        else if (url.pathname === "/favicon.ico") { res.statusCode = 204; return res.end(); }
        else return next();
        if (!existsSync(file)) { res.statusCode = 404; return res.end(); }
        res.setHeader("Content-Type", file.endsWith(".json") ? "application/json" : file.endsWith(".wasm") ? "application/wasm" : "application/octet-stream");
        res.setHeader("Content-Length", statSync(file).size);
        if (req.method === "HEAD") return res.end();
        createReadStream(file).pipe(res);
      });
    },
  }],
  server: { host: "127.0.0.1", port: 8789, strictPort: true },
});
await server.listen();
const args = { modelId: basename(MODEL), modelLib: readdirSync(MODEL).find((name) => name.endsWith(".wasm")), repeats: Number(process.env.REPEATS ?? 20) };
const results = {};
let browser;
try {
  for (const name of (process.env.BROWSERS ?? "edge,firefox").split(",")) {
    const logs = [];
    const report = results[name] = { mode: "visible debug, isolated profile", timestamp: new Date().toISOString(),
      candidate, model: args, logs, networkFailures: [] };
    console.log(`Launching ${name}…`);
    try {
      browser = await puppeteer.launch({
        browser: name === "firefox" ? "firefox" : "chrome", headless: false,
        executablePath: name === "firefox" ? "/Applications/Firefox.app/Contents/MacOS/firefox" : "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
        devtools: name === "edge", timeout: 60_000, protocolTimeout: uploadMode ? 660_000 : 360_000,
        ...(name === "firefox" ? { extraPrefsFirefox: { "dom.webgpu.enabled": true, "gfx.webgpu.ignore-blocklist": true } } : {}),
      });
      report.version = await browser.version();
      report.firefoxPrefs = name === "firefox" ? { webgpuEnabled: true, ignoreBlocklist: true } : undefined;
      const page = await browser.newPage();
      page.setDefaultTimeout(300_000);
      page.on("console", (message) => { const entry = `${message.type()}: ${message.text()}`; logs.push(entry); if (entry.includes("[debug]")) console.log(`${name}: ${entry}`); });
      page.on("pageerror", (error) => logs.push(`pageerror: ${error.stack ?? error}`));
      page.on("requestfailed", (req) => report.networkFailures.push({ url: req.url(), error: req.failure() }));
      page.on("response", (response) => { if (response.status() >= 400) report.networkFailures.push({ url: response.url(), status: response.status() }); });
      await page.goto("http://127.0.0.1:8789", { waitUntil: "networkidle0" });
      await page.waitForFunction((mode) => typeof window[mode === "upload" ? "runUploadBench" : mode ? "runResponses" : "runGPU"] === "function", { timeout: 60_000 }, uploadMode ? "upload" : responsesMode);
      for (const [field, method] of (responsesMode ? [["responses", uploadMode ? "runUploadBench" : "runResponses"]] : [["gpu", "runGPU"], ["noGPU", "runNoGPU"], ["cpu", "runCPU"]])) {
        try {
          report[field] = await Promise.race([
            page.evaluate((method, args) => window[method](args), method, args),
            new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error(`${field} timed out after ${uploadMode ? 10 : 5} minutes`)), uploadMode ? 600_000 : 300_000); timer.unref(); }),
          ]);
          report[field].status = "PASS";
        } catch (error) { report[field] = { status: "FAIL", error: error.stack ?? String(error) }; console.log(`${name} ${field}: FAIL ${error.message}`); }
      }
      report.artifactWarnings = [];
      rmSync(join(ARTIFACTS, `${name}.png`), { force: true });
      try {
        await Promise.race([
          (async () => {
            await page.bringToFront();
            await page.screenshot({ path: join(ARTIFACTS, `${name}.png`), fullPage: false,
              ...(name === "edge" ? { fromSurface: false, captureBeyondViewport: false } : {}) });
          })(),
          new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Screenshot timed out after 20 seconds")), 20_000); timer.unref(); }),
        ]);
      } catch (error) { report.artifactWarnings.push(error.message); }
      report.warnings = logs.filter((entry) => /^(error|warn|pageerror):/.test(entry));
      report.status = (responsesMode ? ["responses"] : ["gpu", "noGPU", "cpu"]).every((key) => report[key].status === "PASS")
        ? (report.warnings.length || report.networkFailures.length || report.artifactWarnings.length ? "PASS_WITH_WARNINGS" : "PASS") : "FAIL";
    } catch (error) { report.status = "FAIL"; report.error = error.stack ?? String(error); }
    finally {
      if (browser) await browser.close().catch(() => {});
      browser = null;
      writeFileSync(join(ARTIFACTS, `${name}.json`), JSON.stringify(report, null, 2));
      console.log(`${name}: ${report.status}; evidence saved under ${ARTIFACTS}`);
    }
  }
} finally {
  if (browser) await browser.close().catch(() => {});
  await server.close();
  if (!process.env.DEBUG_WORK) rmSync(WORK, { recursive: true, force: true });
}
writeFileSync(join(ARTIFACTS, "results.json"), JSON.stringify(results, null, 2));
if (Object.values(results).some((result) => result.status === "FAIL")) process.exitCode = 1;
