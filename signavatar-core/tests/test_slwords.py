"""臺灣手語詞庫 client(injected transport, no network)。

Fixtures 保留站上的真實特徵:`/getwords` 一次給整份詞表,而 `/recword` 是
**隨機**回一支演繹者錄影、沒有列表端點——所以湊齊一個詞要重複抽樣,
抽不到新的就該收工,不能傻抽固定次數。
"""

from signavatar.slwords import (
    Word,
    fetch_words,
    lexicon_keys,
    recording_url,
    safe_name,
    sample_recordings,
)

WORDS = {
    "words": [
        {
            "_id": "S302pxSyHEMR7jG1",
            "name": "軌道",
            "Phonetic": "ㄍㄨㄟˇ ㄉㄠˋ ",
            "AI": "T",
            "bookid": 35,
            "duration": 3220,
            "category": [33, 27],
        },
        {"_id": "x1", "name": "電(B)", "Phonetic": "ㄉㄧㄢˋ ", "AI": "F", "duration": 2500},
        {"_id": "x2", "name": ""},  # 站上偶有空詞條,不能讓它進詞表
    ],
    "phonetics": ["ㄅ", "ㄆ"],
    "category": [{"no": 2, "category": "人權教育"}],
    "pbook": [{"id": 0, "name": "這是什麼", "words": ["蘋果"]}],
}


def test_fetch_words_maps_fields_and_drops_empty_names():
    words, tables = fetch_words(fetch=lambda path: WORDS)
    assert [w.name for w in words] == ["軌道", "電(B)"]
    first = words[0]
    assert first.wid == "S302pxSyHEMR7jG1"
    assert first.phonetic == "ㄍㄨㄟˇ ㄉㄠˋ"        # 站上尾巴有空白
    assert first.categories == [33, 27]
    assert first.has_recordings is True             # AI == "T"
    assert words[1].has_recordings is False
    assert tables["pbook"][0]["name"] == "這是什麼"


def test_video_url_and_stem_quote_the_word():
    w = Word(wid="x", name="電(B)")
    assert w.stem == "slw_電(B)"
    assert w.video_url.endswith("/words/%E9%9B%BB%28B%29.mp4")
    assert recording_url("mEmxx9Oi2iKZKXiL").endswith("/words/recwords/mEmxx9Oi2iKZKXiL.mp4")


def test_lexicon_keys_adds_the_bare_word_for_ab_variants():
    assert lexicon_keys("電(B)") == ["電(B)", "電"]
    assert lexicon_keys("軌道") == ["軌道"]


def test_safe_name_strips_path_hostile_characters():
    assert safe_name("想辦法 (B)") == "想辦法_(B)"
    assert safe_name("a/b:c") == "a_b_c"


def test_sample_recordings_collects_distinct_versions():
    pool = [("f1", "甲"), ("f2", "乙"), ("f1", "甲"), ("f3", "丙")]
    calls = iter(pool)

    def post(path, payload):
        assert path == "/recword" and payload == {"name": "軌道"}
        fn, who = next(calls)
        return {"filename": fn, "presentor": who}

    got = sample_recordings(Word(wid="x", name="軌道"), samples=4, post=post)
    assert got == {"f1": "甲", "f2": "乙", "f3": "丙"}


def test_sample_recordings_stops_when_nothing_new_shows_up():
    """抽樣是隨機的,抽不到新的就該停——不然每個詞都要付滿 samples 次請求。"""
    calls = {"n": 0}

    def post(path, payload):
        calls["n"] += 1
        return {"filename": "same", "presentor": "甲"}

    got = sample_recordings(
        Word(wid="x", name="軌道"), samples=500, post=post, stop_after_idle=3
    )
    assert got == {"same": "甲"}
    assert calls["n"] == 4          # 第一次拿到 + 連續 3 次重複就收工


def test_sample_recordings_keeps_already_known_versions():
    w = Word(wid="x", name="軌道", recordings={"old": "丁"})
    got = sample_recordings(w, samples=1, post=lambda p, d: {"filename": "new", "presentor": "戊"})
    assert got == {"old": "丁", "new": "戊"}
