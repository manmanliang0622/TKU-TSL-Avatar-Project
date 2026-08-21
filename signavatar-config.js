"use strict";

// 學校 GPU 後端（bundle_server，0821 / port 8084）的對外 HTTPS 入口。
// pages.dev 是純靜態站，相對路徑打不到模型與動作片段服務，
// 所以正式站要在這裡填絕對網址；留空則退回同源（本機開發、學校主機直開）。
// 每個瀏覽器也可用 localStorage.glossApi 覆寫，方便換通道時免重新部署。
(() => {
  // cloudflared quick tunnel → 學校電腦 127.0.0.1:8084（0821 bundle_server）。
  // 注意：quick tunnel 重開網址會變，屆時改這一行重新部署，
  // 或在瀏覽器 console 用 localStorage.setItem("glossApi", "新網址") 臨時切換。
  const DEFAULT_API = "https://meters-prepared-register-advertisers.trycloudflare.com";

  let stored = "";
  try { stored = localStorage.getItem("glossApi") || ""; } catch { /* Safari 隱私模式 */ }
  const base = (stored || DEFAULT_API).replace(/\/$/, "");

  window.SignAvatarConfig = base
    ? {
        apiBase: base,
        translateUrl: `${base}/translate`,
        clipsUrl: `${base}/clips`,
      }
    : { translateUrl: "translate" };
})();
