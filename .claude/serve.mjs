import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.cwd();
const SIGNAVATAR_WEB = normalize(join(ROOT, "../TKU-TSL-Avatar-Project-test/backend/web"));
const PORT = Number(process.env.PORT) || 8742;
const MIME = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".svg": "image/svg+xml",
  ".webp": "image/webp",
  ".png": "image/png",
  ".json": "application/json",
  ".txt": "text/plain; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".jpg": "image/jpeg",
  ".vrm": "application/octet-stream",
};

const PROXIES = [
  { prefix: "/signavatar", port: 8000 },
  { prefix: "/model", port: 8018 },
];
const SIGNAVATAR_ASSET_PREFIXES = ["/avatar3d.js", "/composer.js", "/vendor/", "/models/"];

function proxyRequest(req, res, proxy, url) {
  const upstreamPath = url.pathname.slice(proxy.prefix.length) || "/";
  const upstream = httpRequest({
    hostname: "127.0.0.1",
    port: proxy.port,
    method: req.method,
    path: upstreamPath + url.search,
    headers: { ...req.headers, host: `127.0.0.1:${proxy.port}` },
  }, upstreamRes => {
    res.writeHead(upstreamRes.statusCode || 502, upstreamRes.headers);
    upstreamRes.pipe(res);
  });
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: `Local service on port ${proxy.port} is unavailable` }));
  });
  req.pipe(upstream);
}

createServer(async (req, res) => {
  try {
    const url = new URL(req.url, "http://localhost");
    if (SIGNAVATAR_ASSET_PREFIXES.some(prefix =>
      url.pathname === prefix || url.pathname.startsWith(prefix))) {
      const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
      const file = normalize(join(SIGNAVATAR_WEB, relativePath));
      if (!file.startsWith(SIGNAVATAR_WEB)) { res.writeHead(403).end(); return; }
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
      return;
    }

    if (url.pathname.startsWith("/signavatar/") && !url.pathname.startsWith("/signavatar/api/")) {
      const relativePath = decodeURIComponent(url.pathname.slice("/signavatar/".length));
      const file = normalize(join(SIGNAVATAR_WEB, relativePath));
      if (!file.startsWith(SIGNAVATAR_WEB)) { res.writeHead(403).end(); return; }
      const data = await readFile(file);
      res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
      res.end(data);
      return;
    }

    const proxy = PROXIES.find(candidate =>
      url.pathname === candidate.prefix || url.pathname.startsWith(`${candidate.prefix}/`));
    if (proxy) {
      proxyRequest(req, res, proxy, url);
      return;
    }

    let path = decodeURIComponent(url.pathname);
    if (path === "/") path = "/index.html";
    const file = normalize(join(ROOT, path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream" });
    res.end(data);
  } catch {
    res.writeHead(404).end("Not Found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}`));
