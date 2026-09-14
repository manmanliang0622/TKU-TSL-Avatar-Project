/* 根層 middleware 的行為驗證：舊網域轉址、內部檔案 404、前端資源放行。
   需要 node >= 18（用到全域的 Request/Response）。在開發機上跑：

       node tests/pages_middleware.mjs
*/
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const { onRequest } = await import(pathToFileURL(`${root}/functions/_middleware.js`).href);

let failed = 0;
function eq(label, got, expected) {
  const ok = JSON.stringify(got) === JSON.stringify(expected);
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${label.padEnd(44)} → ${JSON.stringify(got)}${ok ? "" : `   期望 ${JSON.stringify(expected)}`}`);
}

async function statusOf(pathname, host = "signbridge-2co.pages.dev") {
  const request = new Request(`https://${host}${pathname}`);
  const next = async () => new Response("asset", { status: 200 });
  return (await onRequest({ request, next })).status;
}

console.log("# 內部檔案一律 404");
for (const p of [
  "/start_0813.sh",
  "/README_0813.md",
  "/PLAN.md",
  "/bundle_server.py",
  "/.gitignore",
  "/.claude/launch.json",
  "/signavatar-core/tools/moe_bulk_all.sh",
  "/signavatar-core/data/tsl_gloss_dataset/raw/tsl_sentences.csv",
  "/tests/test_bundle_server.py",
  "/START_0813.SH",
  "/start_0813%2Esh",
  "//tests//api_proxy.mjs",
  "/%E0%A4%A",
]) eq(p, await statusOf(p), 404);

console.log("# 前端資源照常放行");
for (const p of [
  "/",
  "/index.html",
  "/script.js",
  "/style.css",
  "/vendor/three.module.js",
  "/models/student.vrm",
  "/models.json",
  "/labels.json",
  "/recordings/lexicon.json",
  "/sitemap.xml",
  "/api/health",
  `/${encodeURIComponent("彩色圖_aligned.webp")}`,
]) eq(p, await statusOf(p), 200);

console.log("# 舊網域仍然 301");
eq("tku-tsl-avatar-project.pages.dev/start_0813.sh", await statusOf("/start_0813.sh", "tku-tsl-avatar-project.pages.dev"), 301);

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
