"use strict";

// 後端（學校 GPU 上的 bundle_server，port 8084）的入口位址。
//
// 靜態部署（pages.dev）打不到學校那台，所以走同源的 /api/*：
// functions/api/[[path]].js 這支 Pages Function 會轉過去，真正的 tunnel
// 網址只存在 Cloudflare KV。換通道時這支檔案不用改、也不必重新部署。
//
// 學校主機直開、或本機用 bundle_server 起站時，/translate 與 /clips 本來
// 就在同源上，用相對路徑直接打，不必繞 proxy。
(() => {
  // 除錯用覆蓋：可以填絕對網址（直接打 tunnel，繞過 proxy），
  // 也可以填 "/api"（例如 wrangler pages dev 在 localhost 上測 Function）。
  let override = "";
  try { override = (localStorage.getItem("glossApi") || "").trim(); } catch { /* Safari 隱私模式 */ }

  // 這些主機上的頁面是 bundle_server 自己送出來的，API 就在同源
  const servedByBackend =
    location.protocol === "file:" ||
    /^(localhost|127\.0\.0\.1|\[::1\]|::1)$/i.test(location.hostname) ||
    /(^|\.)trycloudflare\.com$/i.test(location.hostname);

  // 其餘一律當成靜態部署走 proxy —— 用排除法而不是列出 pages.dev，
  // 之後接上自有網域也不必再動這裡
  const base = (override || (servedByBackend ? "" : "/api")).replace(/\/+$/, "");

  window.SignAvatarConfig = base
    ? {
        apiBase: base,
        translateUrl: `${base}/translate`,
        clipsUrl: `${base}/clips`,
      }
    : { translateUrl: "translate" };
})();
