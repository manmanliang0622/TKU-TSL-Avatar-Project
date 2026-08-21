/* Composer.resolve 的行為驗證。需要 node >= 14（伺服器的 v12 解析不了
   composer.js 既有的 `?.`），所以在開發機上跑：

       node tests/composer_resolve.mjs            # 用真的詞庫
       node tests/composer_resolve.mjs <lexicon>  # 指定詞庫路徑
*/
import fs from "fs";
import path from "path";

const root = path.dirname(new URL(import.meta.url).pathname) + "/..";
const lexPath = process.argv[2] || `${root}/recordings/lexicon.json`;
globalThis.window = globalThis;
new Function(fs.readFileSync(`${root}/composer.js`, "utf8"))();
const C = globalThis.Composer;
const lex = JSON.parse(fs.readFileSync(lexPath, "utf8"));

let failed = 0;
function eq(gloss, expected, note = "") {
  const got = C.resolve(gloss, lex).join("/");
  const ok = got === expected;
  if (!ok) failed++;
  console.log(`${ok ? "ok  " : "FAIL"} ${gloss.padEnd(14)} → ${got || "(空)"}${ok ? "" : `   期望 ${expected || "(空)"}`}${note && ok ? "   " + note : ""}`);
}

console.log("# 數字逐位");
eq("2009", "二/零/零/九");
eq("1924", "一/九/二/四");
eq("1", "一");

console.log("# 外語:有既定手語就用整詞，不指拼");
eq("Line", "LINE");
eq("email", "EMAIL");
eq("app", "APP");

console.log("# 外語:沒有手語又沒有字母動作 → 空，不要亂拼");
eq("KTV", "");
eq("NIKE", "");

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

console.log(failed ? `\n${failed} 項失敗` : "\n全部通過");
process.exit(failed ? 1 : 0);
