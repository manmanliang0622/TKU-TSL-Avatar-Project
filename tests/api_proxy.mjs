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
let upstreamHeaders = null;
globalThis.fetch = async (url, init) => {
  upstream = url;
  upstreamHeaders = init?.headers;
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

async function callBody(method, route) {
  const req = new Request(`https://site.pages.dev/api/${route}`, {
    method, headers: { "Content-Type": "application/json" }, body: "{}",
  });
  const res = await onRequest({ request: req, env: KV("https://kv.example"), params: { path: route.split("/") } });
  const text = await res.text();
  let json = null;
  try { json = JSON.parse(text); } catch { /* 留 null，讓 eq 報出來 */ }
  return { status: res.status, json };
}

console.log("# 白名單內的路徑照轉，query 保留");
eq("POST translate", (await call("POST", "translate")).upstream, "https://kv.example/translate");
eq("POST clips", (await call("POST", "clips")).upstream, "https://kv.example/clips");
eq("GET clip?…", (await call("GET", "clip", { search: "?name=a&start=1" })).upstream, "https://kv.example/clip?name=a&start=1");

console.log("# 語音輸入：音訊照轉，並帶上真正的來源給後端限流");
eq("POST transcribe", (await call("POST", "transcribe")).upstream, "https://kv.example/transcribe");
eq("GET transcribe（錯的動詞）", (await call("GET", "transcribe")).status, 405);
{
  const req = new Request("https://site.pages.dev/api/transcribe", {
    method: "POST",
    headers: { "Content-Type": "audio/webm;codecs=opus", "CF-Connecting-IP": "203.0.113.9" },
    body: new Uint8Array([1, 2, 3]),
  });
  await onRequest({ request: req, env: KV("https://kv.example"), params: { path: ["transcribe"] } });
  eq("來源 IP → X-Tsl-Client", upstreamHeaders.get("X-Tsl-Client"), "203.0.113.9");
  eq("音訊的 Content-Type 原樣帶過", upstreamHeaders.get("Content-Type"), "audio/webm;codecs=opus");
}
eq("前端設定：pages.dev 走 proxy", configFor("signbridge-2co.pages.dev").transcribeUrl, "/api/transcribe");
eq("前端設定：學校主機同源", configFor("127.0.0.1", "http:").transcribeUrl, "transcribe");

console.log("# 白名單外一律擋掉（後端也在服務 models/、recordings/）");
eq("POST recordings", (await call("POST", "recordings")).status, 404);
eq("GET clip/deep/path", (await call("GET", "clip/deep/path")).status, 404);
eq("GET translate（錯的動詞）", (await call("GET", "translate")).status, 405);

console.log("# 手語辨識掛在 knee42/ 底下，恰好兩段才轉");
eq("POST knee42/stream", (await call("POST", "knee42/stream")).upstream, "https://kv.example/knee42/stream");
eq("POST knee42/predict", (await call("POST", "knee42/predict")).upstream, "https://kv.example/knee42/predict");
eq("GET knee42/health", (await call("GET", "knee42/health")).upstream, "https://kv.example/knee42/health");
eq("GET knee42/labels", (await call("GET", "knee42/labels")).upstream, "https://kv.example/knee42/labels");
// 辨識服務還有 /analyze_url（會對外抓影片）等端點，不在白名單上的不轉
eq("POST knee42/analyze_url", (await call("POST", "knee42/analyze_url")).status, 404);
eq("GET knee42（少一段）", (await call("GET", "knee42")).status, 404);
eq("POST knee42/stream/x（多一段）", (await call("POST", "knee42/stream/x")).status, 404);
eq("GET knee42/stream（錯的動詞）", (await call("GET", "knee42/stream")).status, 405);

console.log("# KV 讀不到就用保底網址，不是整個壞掉");
eq("KV 未綁定", (await call("POST", "translate", { env: {} })).upstream.endsWith("/translate"), true);
eq("KV 空值", (await call("POST", "translate", { env: KV("  ") })).upstream.endsWith("/translate"), true);

console.log("# 回應標頭");
const headers = (await call("POST", "translate")).headers;
eq("content-encoding 已拿掉", headers["content-encoding"], undefined);
eq("CORS 標頭已拿掉", headers["access-control-allow-origin"], undefined);
eq("cache-control 保留", headers["cache-control"], "public, max-age=604800, immutable");

console.log("# 回應標頭要講出網址是哪裡來的");
// binding 名字打錯時 env.TSL_CONFIG 是 undefined，會安靜退回保底值，
// 而保底值多半就是當下能用的網址 —— 沒有這個標頭就看不出來
eq("KV 有值 → kv", (await call("POST", "translate")).headers["x-tsl-api-base-source"], "kv");
eq("KV 未綁定 → fallback",
   (await call("POST", "translate", { env: {} })).headers["x-tsl-api-base-source"], "fallback");
eq("KV 未綁定但有環境變數 → env",
   (await call("POST", "translate", { env: { TUNNEL_ORIGIN: "https://x.example" } })).headers["x-tsl-api-base-source"], "env");
eq("KV 空值 → fallback",
   (await call("POST", "translate", { env: KV("  ") })).headers["x-tsl-api-base-source"], "fallback");

console.log("# tunnel 掛掉時回 502，前端才好退回內建對照表");
globalThis.fetch = async () => { throw new Error("tunnel down"); };
eq("上游不通", (await call("POST", "clips")).status, 502);
eq("上游不通 → 辨識前端讀得到 JSON", (await callBody("POST", "knee42/stream")).json?.ok, false);

console.log("# 辨識：Cloudflare 那一段吐純文字時，前端拿到的仍是 JSON");
// 2026-09-14 20:20：瀏覽器收到「Error: Network connection lost.」純文字，
// 前端 res.json() 只丟出一句 Unexpected token 'E'，後端日誌裡沒有這個請求
globalThis.fetch = async () => new Response("Error: Network connection lost.", {
  status: 500, headers: { "Content-Type": "text/plain" },
});
const lost = await callBody("POST", "knee42/stream");
eq("純文字 → 502", lost.status, 502);
eq("純文字 → ok:false 的 JSON", lost.json?.ok, false);
eq("原文留在 message 裡", /Network connection lost/.test(lost.json?.message || ""), true);

globalThis.fetch = async () => new Response(new ReadableStream({
  pull(controller) { controller.error(new Error("Network connection lost.")); },
}), { status: 200, headers: { "Content-Type": "application/json" } });
const cut = await callBody("POST", "knee42/predict");
eq("讀回應讀到一半斷線 → 502", cut.status, 502);
eq("讀回應讀到一半斷線 → JSON", cut.json?.ok, false);

globalThis.fetch = async () => new Response('{"ok": false, "message": "payload is empty or too large"}', {
  status: 400, headers: { "Content-Type": "application/json" },
});
const bad = await callBody("POST", "knee42/predict");
eq("後端自己的 JSON 錯誤原樣帶過", [bad.status, bad.json?.message], [400, "payload is empty or too large"]);

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
