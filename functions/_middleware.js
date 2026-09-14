// 舊網域 301 到正式網址。兩個 *.pages.dev 網域掛的是同一份部署，
// 所以只能在這裡看 Host 決定轉不轉；index.html 那段 JS 轉址只有
// 瀏覽器會執行，Google 不吃，索引一直停在舊網址。
// 注意：加了根層 middleware 後所有路徑都會先經過這裡，一定要 next() 放行。
const CANONICAL_HOST = "signbridge-2co.pages.dev";
const OLD_HOSTS = new Set(["tku-tsl-avatar-project.pages.dev"]);

// Pages 會把 repo 整棵樹當靜態檔送出，連維運腳本、後端程式、內部文件與
// 資料蒐集工具都下載得到（start_0813.sh 曾帶著主機位址與帳號掛在線上）。
// 前端執行用不到這些，一律回 404。前端自己的 .mjs 都從 CDN 載，不受影響。
const HIDDEN_DIRS = new Set(["signavatar-core", "tests", ".claude", "backups", "logs"]);
const HIDDEN_FILE = /\.(sh|py|pyc|md|lock|toml|mjs|log|pid)$|\/\.[^/]+$/;

function isHidden(pathname) {
  let path;
  try {
    path = decodeURIComponent(pathname);
  } catch {
    return true; // 百分號編碼壞掉的路徑不可能是正常資源
  }
  path = path.replace(/\/{2,}/g, "/").toLowerCase();
  return HIDDEN_DIRS.has(path.split("/")[1]) || HIDDEN_FILE.test(path);
}

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (OLD_HOSTS.has(url.hostname)) {
    url.hostname = CANONICAL_HOST;
    return Response.redirect(url.toString(), 301);
  }
  if (isHidden(url.pathname)) {
    return new Response("Not found", { status: 404, headers: { "Cache-Control": "no-store" } });
  }
  return context.next();
}
