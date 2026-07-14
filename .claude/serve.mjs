import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.cwd();
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
};

createServer(async (req, res) => {
  try {
    let path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);
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
