// 舊網域 301 到正式網址。兩個 *.pages.dev 網域掛的是同一份部署，
// 所以只能在這裡看 Host 決定轉不轉；index.html 那段 JS 轉址只有
// 瀏覽器會執行，Google 不吃，索引一直停在舊網址。
// 注意：加了根層 middleware 後所有路徑都會先經過這裡，一定要 next() 放行。
const CANONICAL_HOST = "signbridge-2co.pages.dev";
const OLD_HOSTS = new Set(["tku-tsl-avatar-project.pages.dev"]);

export async function onRequest(context) {
  const url = new URL(context.request.url);
  if (OLD_HOSTS.has(url.hostname)) {
    url.hostname = CANONICAL_HOST;
    return Response.redirect(url.toString(), 301);
  }
  return context.next();
}
