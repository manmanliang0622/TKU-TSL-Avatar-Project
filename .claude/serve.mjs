import { createServer, request as httpRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { extname, join, normalize } from "node:path";

const ROOT = process.cwd();
const PORT = Number(process.env.PORT) || 8742;
// 語言模型 API（SSH 通道到學校主機 bundle_server）
const GLOSS_PROXY_TARGET = { host: "127.0.0.1", port: 8018 };
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
  const path = decodeURIComponent(new URL(req.url, "http://localhost").pathname);

  // 同源代理：嵌入式瀏覽器擋跨埠 loopback 請求，改由這裡轉發到通道
  // /recordings/* 先讀本地（lexicon.json 已抓回），缺檔再走通道拉整段錄製
  // /recognize/* 交給學校那台的 bundle_server 再轉 Knee42 辨識服務
  const proxyPath = path === "/translate" || path === "/clips" || path === "/lexicon"
    || path.startsWith("/recognize/");
  if (proxyPath) {
    const upstream = httpRequest(
      { ...GLOSS_PROXY_TARGET, path, method: req.method, headers: {
          "content-type": req.headers["content-type"] || "application/json",
          ...(req.headers["content-length"] ? { "content-length": req.headers["content-length"] } : {}),
        } },
      (up) => {
        res.writeHead(up.statusCode || 502, { "Content-Type": up.headers["content-type"] || "application/json" });
        up.pipe(res);
      }
    );
    upstream.on("error", () => {
      res.writeHead(502, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "gloss api tunnel unreachable" }));
    });
    req.pipe(upstream);
    return;
  }

  try {
    const file = normalize(join(ROOT, path === "/" ? "/index.html" : path));
    if (!file.startsWith(ROOT)) { res.writeHead(403).end(); return; }
    const data = await readFile(file);
    res.writeHead(200, { "Content-Type": MIME[extname(file)] || "application/octet-stream",
      "Cache-Control": "no-store" });
    res.end(data);
  } catch {
    if (path.startsWith("/recordings/")) {
      const upstream = httpRequest({ ...GLOSS_PROXY_TARGET, path, method: "GET" }, (up) => {
        res.writeHead(up.statusCode || 502, { "Content-Type": up.headers["content-type"] || "application/json" });
        up.pipe(res);
      });
      upstream.on("error", () => { res.writeHead(502).end(); });
      upstream.end();
      return;
    }
    res.writeHead(404).end("Not Found");
  }
}).listen(PORT, "127.0.0.1", () => console.log(`serving ${ROOT} at http://127.0.0.1:${PORT}`));
