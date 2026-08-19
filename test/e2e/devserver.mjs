/** Serves a local model folder to the extension and collects its test report. */
import { createServer } from "node:http";
import { createReadStream } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "content-type",
  "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
};

export function startServer({ dir, port, onReport }) {
  const server = createServer(async (req, res) => {
    if (req.method === "OPTIONS") return res.writeHead(204, CORS).end();

    if (req.url === "/manifest") {
      const names = (await readdir(dir)).filter((n) => !n.startsWith("."));
      const files = await Promise.all(
        names.map(async (name) => ({ name, size: (await stat(join(dir, name))).size })),
      );
      res.writeHead(200, { ...CORS, "content-type": "application/json" });
      return res.end(JSON.stringify({ folder: basename(dir), files }));
    }

    if (req.url?.startsWith("/files/")) {
      const name = decodeURIComponent(req.url.slice("/files/".length));
      if (name.includes("/") || name.includes("..")) return res.writeHead(400, CORS).end();
      res.writeHead(200, { ...CORS, "content-type": "application/octet-stream" });
      return createReadStream(join(dir, name)).pipe(res);
    }

    if (req.method === "POST" && req.url === "/report") {
      let body = "";
      req.on("data", (c) => (body += c));
      req.on("end", () => {
        res.writeHead(204, CORS).end();
        onReport(JSON.parse(body));
      });
      return;
    }

    res.writeHead(404, CORS).end();
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}
