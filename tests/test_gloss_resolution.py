"""Composer 的 gloss → 動作解析契約。

行為驗證要用 node ≥14 跑 `tests/composer_resolve.mjs`(伺服器的 node 是 v12,
解析不了 composer.js 既有的 `?.`)。這裡守的是契約:resolve 回傳陣列、三個
呼叫端都當陣列用、數字與指拼的對照表齊全 —— 這些一旦破掉,虛擬人會安靜地
少打或亂打詞,不會有任何錯誤訊息。
"""
from pathlib import Path
import re
import unittest

PROJECT_ROOT = Path(__file__).resolve().parents[1]


class GlossResolutionTests(unittest.TestCase):
    def setUp(self):
        self.composer = (PROJECT_ROOT / "composer.js").read_text(encoding="utf-8")
        self.bridge = (PROJECT_ROOT / "signavatar-bridge.js").read_text(encoding="utf-8")

    def test_resolve_is_the_single_entry_point(self):
        self.assertIn("function resolve(gloss, lexicon)", self.composer)
        self.assertIn("resolve,", self.composer)          # 有匯出,bridge 才用得到

    def test_every_caller_treats_resolve_as_a_list(self):
        # 一個 token 可以展開成多個動作(2009 → 二/零/零/九),把回傳值當單一
        # 鍵用會靜靜地把整串數字變成 undefined
        self.assertIn("tokens.push(...whole)", self.composer)
        self.assertIn("tokens.flatMap(name => resolve(name, lexicon))", self.composer)
        self.assertIn("Composer.resolve(token, lexicon).length", self.bridge)

    def test_build_iterates_the_expanded_signs_not_raw_tokens(self):
        self.assertIn("for (const name of signs) {", self.composer)

    def test_digit_signs_cover_every_digit(self):
        match = re.search(r"const DIGIT_SIGN = \[(.*?)\];", self.composer, re.S)
        self.assertIsNotNone(match)
        signs = re.findall(r"\"(.)\"", match.group(1))
        self.assertEqual(signs, list("零一二三四五六七八九"))

    def test_fingerspelling_uses_a_namespaced_key(self):
        # 字母動作用 fs: 前綴,否則會跟詞庫裡真的叫 A、C 的詞條撞名
        self.assertIn("`fs:${ch.toUpperCase()}`", self.composer)
        # 缺任何一個字母就整個不打,不要拼出殘缺的字串
        self.assertIn("keys.every(k => lexicon[k]) ? keys : []", self.composer)

    def test_case_folding_index_is_cached(self):
        # 每個 token 都重掃 14,000 個鍵會讓整句組裝變慢
        self.assertIn("if (foldedFor === lexicon) return foldedIdx;", self.composer)


if __name__ == "__main__":
    unittest.main()
