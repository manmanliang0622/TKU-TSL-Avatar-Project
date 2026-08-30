/* 固定 API 入口：把 /api/* 轉給學校那台的 bundle_server。
 *
 * 後端對外走 cloudflared quick tunnel，網址每次重拉都會變。舊做法是讓
 * autopublish 改 signavatar-config.js、push 上 GitHub、等 Pages 重新部署
 * —— 從偵測到換址算起要三到五分鐘，這段期間前端手上是死網址，/clips 打不到，
 * 虛擬人完全不動（動作資料只在學校那台，靜態站沒有 recordings/ 可退）。
 *
 * 現在網址只存在 KV：autopublish 換完 tunnel 直接寫 KV，前端這一側永遠是
 * 同源的 /api/*，不必改檔也不必重新部署。同源之後 CORS 一併不存在。
 *
 * 綁定（Pages → Settings → Functions）：
 *   KV namespace  TSL_CONFIG   鍵 apiBase = 目前的 tunnel 網址
 *   環境變數      TUNNEL_ORIGIN（選用）KV 讀不到時的保底值
 */

// KV 還沒設好、或 namespace 被清掉時的最後保底。這是整個前端唯一還寫死
// tunnel 網址的地方，而且只在 KV 讀不到時才會用到。
const FALLBACK_ORIGIN = "https://loved-loved-athletic-several.trycloudflare.com";

// 只轉這幾條。bundle_server 同時也在服務 models/、recordings/、vendor/ 等
// 靜態目錄，不設白名單的話這支 proxy 會變成整台機器的公開跳板。
const ROUTES = {
  translate: ["POST", "OPTIONS"],
  clips: ["POST", "OPTIONS"],
  clip: ["GET", "HEAD"],
  health: ["GET"],
};

// 手語辨識端（Knee42）：bundle_server 的 /knee42/* 會再轉給同機 8642 的
// Knee42 webservice。一樣採白名單，只放行這四條子路徑，其餘照擋。
const KNEE42_ROUTES = {
  health: ["GET"],
  labels: ["GET"],
  predict: ["POST", "OPTIONS"],
  stream: ["POST", "OPTIONS"],
};

// 模型冷啟動要幾十秒（前端自己抓 60s），留一點餘裕再放棄，
// 免得請求卡在那裡直到執行環境把它砍掉、前端只看到一個沒有訊息的失敗。
const UPSTREAM_TIMEOUT_MS = 90_000;

// 上游的壓縮與長度由執行環境自己重算，原樣帶過去會變成雙重編碼
const DROP_RESPONSE_HEADERS = new Set([
  "content-encoding",
  "content-length",
  "transfer-encoding",
  "connection",
  // 同源了，後端那個 * 的 CORS 標頭沒有意義，不要再往外送
  "access-control-allow-origin",
  "access-control-allow-headers",
  "access-control-allow-methods",
]);

function json(status, payload) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" },
  });
}

/* KV 讀取在邊緣有快取，cacheTtl 最小值是 30 秒，所以換址後最壞情況會有
   半分鐘還轉到舊網址 —— 仍遠好過原本的三到五分鐘，而且不必動 repo。

   回傳裡帶 source：binding 名字打錯時 env.TSL_CONFIG 是 undefined，會安靜
   地退回保底值，而保底值多半就是當下那個能用的網址 —— 於是一切看起來都
   正常，直到某天 tunnel 換址才發現自動換址從來沒生效過。把來源送進回應
   標頭，這種無聲失敗一眼就看得出來。 */
async function upstreamOrigin(env) {
  try {
    const stored = await env.TSL_CONFIG?.get("apiBase", { cacheTtl: 30 });
    if (stored && stored.trim()) return { origin: stored.trim().replace(/\/+$/, ""), source: "kv" };
  } catch {
    // KV 不通就往下用保底值：少了自動換址，總比整站沒有虛擬人好
  }
  return {
    origin: String(env.TUNNEL_ORIGIN || FALLBACK_ORIGIN).replace(/\/+$/, ""),
    source: env.TUNNEL_ORIGIN ? "env" : "fallback",
  };
}

export async function onRequest({ request, env, params }) {
  const segments = (Array.isArray(params.path) ? params.path : [params.path]).filter(Boolean);
  const route = segments[0] || "";

  // 白名單比對：一般路由只看第一段且不接受更深的路徑（/api/clip 可以，
  // /api/recordings/xxx.json 或 /api/clip/../models 都擋掉）；
  // knee42 是唯一的兩段式路由，第二段也要在白名單內。
  let allowed = null;
  let upstreamPath = route;
  if (route === "knee42") {
    if (segments.length === 2 && Object.prototype.hasOwnProperty.call(KNEE42_ROUTES, segments[1])) {
      allowed = KNEE42_ROUTES[segments[1]];
      upstreamPath = `knee42/${segments[1]}`;
    }
  } else if (segments.length === 1 && Object.prototype.hasOwnProperty.call(ROUTES, route)) {
    allowed = ROUTES[route];
  }
  if (!allowed) return json(404, { error: "not found" });
  if (!allowed.includes(request.method)) return json(405, { error: "method not allowed" });

  // 同源請求本來就不會有預檢；這裡回一個空的 204 只是不讓別人踩到 405
  if (request.method === "OPTIONS") return new Response(null, { status: 204 });

  const { origin, source } = await upstreamOrigin(env);
  const target = `${origin}/${upstreamPath}${new URL(request.url).search}`;

  const headers = new Headers();
  const contentType = request.headers.get("content-type");
  if (contentType) headers.set("Content-Type", contentType);

  let upstream;
  try {
    upstream = await fetch(target, {
      method: request.method,
      headers,
      body: request.method === "GET" || request.method === "HEAD" ? undefined : request.body,
      signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      redirect: "manual",
    });
  } catch (error) {
    // tunnel 掛了或還在重拉。前端的 fetch 已經有 catch，會退回內建對照表
    // （/translate）或直接顯示詞庫缺動畫（/clips），不會整頁壞掉。
    return json(502, { error: `upstream unreachable: ${error?.message || error}`, source });
  }

  const out = new Headers();
  for (const [name, value] of upstream.headers) {
    if (!DROP_RESPONSE_HEADERS.has(name.toLowerCase())) out.set(name, value);
  }
  // 只講來源，不講網址：位址本身沒必要對外公開
  out.set("X-Tsl-Api-Base-Source", source);
  return new Response(upstream.body, { status: upstream.status, statusText: upstream.statusText, headers: out });
}
