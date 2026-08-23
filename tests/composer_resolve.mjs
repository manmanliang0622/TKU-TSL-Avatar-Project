/* Composer.resolve 的行為驗證。需要 node >= 14（伺服器的 v12 解析不了
   composer.js 既有的 `?.`），所以在開發機上跑：

       node tests/composer_resolve.mjs            # 用真的詞庫
       node tests/composer_resolve.mjs <lexicon>  # 指定詞庫路徑
*/
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// fileURLToPath 而不是 new URL(...).pathname：這個 repo 的路徑有中文，
// pathname 是百分號編碼過的，直接餵給 fs 會 ENOENT
const root = path.dirname(fileURLToPath(import.meta.url)) + "/..";
const lexPath = process.argv[2] || `${root}/recordings/lexicon.json`;
globalThis.window = globalThis;
new Function(fs.readFileSync(`${root}/composer.js`, "utf8"))();
const C = globalThis.Composer;
const lex = JSON.parse(fs.readFileSync(lexPath, "utf8"));

let failed = 0;
function eq(gloss, expected, note = "", lexicon = lex) {
  const got = C.resolve(gloss, lexicon).join("/");
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${gloss.padEnd(14)} → ${got || "(空)"}${ok ? "" : `   期望 ${expected || "(空)"}`}${note && ok ? "   " + note : ""}`);
}

/* 詞庫少了某幾個鍵時的行為。字面詞條會遮住後面的展開路徑,拿掉才測得到。 */
function without(keys, gloss, expected, note = "") {
  const trimmed = { ...lex };
  for (const key of keys) delete trimmed[key];
  eq(gloss, expected, note, trimmed);
}

/* resolve 的第一步就是 `lexicon[gloss]`,所以只要詞庫收了字面詞條,
   逐位數字與指拼都不會跑到。這是對的:語料庫那些片段是聾人受訪者實際
   怎麼打「2009」「NIKE」的紀錄,比拆成四個數字手語或逐字母指拼更接近
   真實手語。所以兩件事都要測——字面詞條在的時候優先,不在的時候才展開。 */
console.log("# 數字:詞庫收了整串就用整串");
eq("2009", "2009", "moc 語料庫標的整串年份");
eq("1924", "1924");
eq("1", "1");

console.log("# 數字:詞庫沒有整串才逐位展開");
without(["2009"], "2009", "二/零/零/九");
without(["1924"], "1924", "一/九/二/四");
without(["1"], "1", "一");

console.log("# 外語:詞庫收了這個寫法就直接用");
eq("Line", "Line");
eq("email", "email");
eq("app", "app");
eq("NIKE", "NIKE", "以前查不到整個跳過,現在有真的片段可播");

console.log("# 外語:詞庫沒有這個寫法 → 大小寫折疊 → 指拼 → 空");
without(["Line"], "Line", "LINE", "折疊到同義的 LINE");
without(["NIKE"], "NIKE", "", "沒有字母動作就不要亂拼");
eq("KTV", "", "詞庫從頭到尾就沒有 KTV");

console.log("# 複合詞：詞庫沒有這個鍵，但拆成幾個既有動作連著打");
eq("飛機起降", "飛機/起飛/降落");
{
  const noTakeoff = { ...lex };
  delete noTakeoff["起飛"];
  const got = C.resolve("飛機起降", noTakeoff).join("/");
  const ok = got === "";
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} 飛機起降(缺一段) → ${got || "(空)"}${ok ? "   缺一段就整個不打" : "   期望 (空)"}`);
}

console.log("# 方向動詞：詞根 + 人稱代名詞（2026-08-22 盤點 14 個 gloss 卡在這）");
eq("相信我", "相信/我");
eq("看自己", "看/自己", "自己 也算人稱");
eq("回答你", "回答/你");
eq("屬於他們", "屬於/他們", "長的代名詞先比，不能被 他 截走");
without(["妳"], "幫妳", "幫/你", "詞庫沒有 妳 就折到 你");
without(["相信"], "相信我", "", "詞根沒影片就整個不打");

console.log("# 乾淨複合：每段都是 ≥2 字的既有詞條才切");
eq("三個小時", "三個/小時");
eq("兩者距離", "兩者/距離");
eq("搭飛機抵達", "搭飛機/抵達", "最長優先");
eq("仔細看", "", "含單字塊不收（看）");
eq("張老師", "", "含單字塊不收（張 會打成姓氏）");
eq("之於", "", "兩個單字不是複合");
without(["小時"], "三個小時", "", "切出破洞就整個不打");

console.log("# 標註記號與別名（既有行為不能壞）");
eq("買++", "買");
eq("告訴(他)", "告訴");
eq("南投", "南投");
eq("妳", "妳");

console.log("# 字母錄進來之後自動生效");
const withFs = { ...lex };
for (const ch of "ABCDEFGHIJKLMNOPQRSTUVWXYZ") withFs[`fs:${ch}`] = { recording: "x.json", start: 0, end: 1 };
const ktv = C.resolve("KTV", withFs).join("/");
const ok = ktv === "fs:K/fs:T/fs:V";
if (!ok) failed++;
console.log(`${ok ? "ok  " : "FAIL"} KTV(有字母)   → ${ktv}`);
// 字面詞條仍然優先:NIKE 有整詞就播整詞,拿掉才輪到指拼
eq("NIKE", "NIKE", "整詞優先於指拼", withFs);
const fsNoNike = { ...withFs };
delete fsNoNike["NIKE"];
eq("NIKE", "fs:N/fs:I/fs:K/fs:E", "沒有整詞才逐字母", fsNoNike);

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
