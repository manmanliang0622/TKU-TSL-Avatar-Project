"""詞庫維護：補登既有影片、補別名鍵。"""

from signavatar.lexicon import alias_entries, backfill_entries


def _entry(rec, **kw):
    return {"recording": rec, "start": 0.0, "end": 2.0, **kw}


def test_alias_strips_variant_suffix():
    lex = {"美國_A": _entry("0001_美國_A.json"), "美國_B": _entry("0002_美國_B.json")}
    out = alias_entries(lex)
    assert out["美國"]["alias_of"] == "美國_A"          # 多候選取排序第一個，結果可重現
    assert out["美國"]["recording"] == "0001_美國_A.json"


def test_alias_strips_admin_suffix_for_placenames():
    lex = {"南投縣": _entry("pn_0529_南投縣1.json", source="placename:529")}
    assert alias_entries(lex)["南投"]["alias_of"] == "南投縣"


def test_alias_leaves_admin_suffix_alone_on_non_placenames():
    # 一日千里 不是地名，「里」不是行政區後綴
    lex = {"一日千里": _entry("1234_一日千里.json", source="twtsl:1234")}
    assert "一日千" not in alias_entries(lex)


def test_alias_refuses_single_char_admin_base():
    # 夜市 → 夜 會被 tokenize 拿去拼別的詞，寧可不生
    lex = {"夜市": _entry("pn_1.json", source="placename:1")}
    assert "夜" not in alias_entries(lex)


def test_alias_adds_character_variants():
    out = alias_entries({"你": _entry("a.json"), "台北": _entry("b.json")})
    assert out["妳"]["alias_of"] == "你"
    assert out["臺北"]["alias_of"] == "台北"


def test_alias_never_shadows_an_existing_key():
    # 南投 已經是自然手語詞條 → 不可被 南投縣 的別名蓋掉
    lex = {"南投縣": _entry("pn.json"), "南投": _entry("moc_G1.json", source="moc:G1")}
    assert "南投" not in alias_entries(lex)


def test_alias_does_not_chain_off_another_alias():
    lex = {"美國_A": _entry("a.json"),
           "美國": {**_entry("a.json"), "alias_of": "美國_A"}}
    # 別名本身不再生別名（否則 alias_of 會指到別名、追不回原始詞條）
    assert all(v["alias_of"] == "美國_A" for v in alias_entries(lex).values())


def test_alias_is_idempotent():
    lex = {"美國_A": _entry("a.json")}
    lex.update(alias_entries(lex))
    assert alias_entries(lex) == {}


def test_backfill_adds_free_words_with_all_synonyms():
    signs = [{"id": 16, "recording": "0015_伴.json", "words": ["伴", "陪伴"],
              "description": "兩手食指併攏前移。"}]
    out = backfill_entries({}, signs, lambda r: 3.5)
    assert out["伴"]["source"] == "twtsl:16" and out["陪伴"]["source"] == "twtsl:16"
    assert out["伴"]["end"] == 3.5
    assert out["陪伴"]["text"] == "兩手食指併攏前移。"


def test_backfill_skips_words_already_in_lexicon():
    signs = [{"id": 16, "recording": "0015_伴.json", "words": ["伴", "陪伴"], "description": ""}]
    out = backfill_entries({"伴": _entry("moc_G1.json")}, signs, lambda r: 3.5)
    assert set(out) == {"陪伴"}          # 既有的 伴 保留，只補沒有的同義名


def test_backfill_skips_signs_whose_recording_is_missing():
    signs = [{"id": 9, "recording": "nope.json", "words": ["算盤"], "description": ""}]
    assert backfill_entries({}, signs, lambda r: None) == {}


def test_backfill_does_not_duplicate_a_word_across_signs():
    signs = [{"id": 1, "recording": "a.json", "words": ["加"], "description": ""},
             {"id": 2, "recording": "b.json", "words": ["加"], "description": ""}]
    out = backfill_entries({}, signs, lambda r: 1.0)
    assert out["加"]["source"] == "twtsl:1"      # 先到先得，第二支不覆蓋
