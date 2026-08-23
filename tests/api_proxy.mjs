/* 固定 API 入口的行為驗證：signavatar-config.js 決定要不要走 proxy，
   functions/api/[[path]].js 決定轉不轉、轉去哪。需要 node >= 18（用到
   全域的 fetch/Request/Response）。在開發機上跑：

       node tests/api_proxy.mjs
*/
import fs from "fs";
import path from "path";
import vm from "vm";
import { fileURLToPath, pathToFileURL } from "url";

// fileURLToPath 而不是 new URL(...).pathname：這個 repo 的路徑有中文，
// pathname 是百分號編碼過的，直接餵給 fs 會 ENOENT
const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const { onRequest } = await import(pathToFileURL(`${root}/functions/api/[[path]].js`).href);
const configSrc = fs.readFileSync(`${root}/signavatar-config.js`, "utf8");

let failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(38)} → ${JSON.stringify(got)}${ok ? "" : `   期望 ${JSON.stringify(expected)}`}`);
}

/* ── signavatar-config.js ───────────────────────────────────────────── */
function configFor(hostname, protocol = "https:", stored = null) {
  const ctx = { location: { hostname, protocol }, localStorage: { getItem: () => stored } };
  ctx.window = ctx;
  vm.runInContext(configSrc, vm.createContext(ctx));
  return ctx.window.SignAvatarConfig;
}
const clipsFor = (...args) => configFor(...args).clipsUrl || "(相對路徑)";

console.log("# 靜態部署走 proxy");
eq("pages.dev", clipsFor("signbridge-2co.pages.dev"), "/api/clips");
// 排除法而不是列 pages.dev：之後接自有網域不必再動這支檔案
eq("自有網域", clipsFor("signbridge.example.org"), "/api/clips");

console.log("# bundle_server 自己送出來的頁面用同源相對路徑");
eq("學校主機 / 本機", clipsFor("127.0.0.1", "http:"), "(相對路徑)");
eq("localhost", clipsFor("localhost", "http:"), "(相對路徑)");
eq("tunnel 直開", clipsFor("x.trycloudflare.com"), "(相對路徑)");

console.log("# localStorage.glossApi 覆蓋（除錯用）");
eq("繞過 proxy 直打 tunnel", clipsFor("signbridge-2co.pages.dev", "https:", "https://t.example/"), "https://t.example/clips");
eq("wrangler pages dev", clipsFor("localhost", "http:", "/api"), "/api/clips");

/* ── functions/api/[[path]].js ──────────────────────────────────────── */
const KV = origin => ({ TSL_CONFIG: { get: async () => origin } });
let upstream = null;
globalThis.fetch = async (url, init) => {
  upstream = url;
  return new Response("{}", {
    status: 200,
    headers: {
      "Content-Type": "application/json",
      "Content-Encoding": "gzip",              // 執行環境會自己重算，不該原樣帶出
      "Access-Control-Allow-Origin": "*",      // 同源了，不該再往外送
      "Cache-Control": "public, max-age=604800, immutable",
    },
  });
};

async function call(method, route, { env = KV("https://kv.example"), search = "" } = {}) {
  upstream = null;
  const req = new Request(`https://site.pages.dev/api/${route}${search}`, {
    method,
    headers: method === "POST" ? { "Content-Type": "application/json" } : {},
    body: method === "POST" ? "{}" : undefined,
  });
  const res = await onRequest({ request: req, env, params: { path: route.split("/").filter(Boolean) } });
  return { status: res.status, upstream, headers: Object.fromEntries(res.headers) };
}

console.log("# 白名單內的路徑照轉，query 保留");
eq("POST translate", (await call("POST", "translate")).upstream, "https://kv.example/translate");
eq("POST clips", (await call("POST", "clips")).upstream, "https://kv.example/clips");
eq("GET clip?…", (await call("GET", "clip", { search: "?name=a&start=1" })).upstream, "https://kv.example/clip?name=a&start=1");

console.log("# 白名單外一律擋掉（後端也在服務 models/、recordings/）");
eq("POST recordings", (await call("POST", "recordings")).status, 404);
eq("GET clip/deep/path", (await call("GET", "clip/deep/path")).status, 404);
eq("GET translate（錯的動詞）", (await call("GET", "translate")).status, 405);

console.log("# KV 讀不到就用保底網址，不是整個壞掉");
eq("KV 未綁定", (await call("POST", "translate", { env: {} })).upstream.endsWith("/translate"), true);
eq("KV 空值", (await call("POST", "translate", { env: KV("  ") })).upstream.endsWith("/translate"), true);

console.log("# 回應標頭");
const headers = (await call("POST", "translate")).headers;
eq("content-encoding 已拿掉", headers["content-encoding"], undefined);
eq("CORS 標頭已拿掉", headers["access-control-allow-origin"], undefined);
eq("cache-control 保留", headers["cache-control"], "public, max-age=604800, immutable");

console.log("# tunnel 掛掉時回 502，前端才好退回內建對照表");
globalThis.fetch = async () => { throw new Error("tunnel down"); };
eq("上游不通", (await call("POST", "clips")).status, 502);

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
