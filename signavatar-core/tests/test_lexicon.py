"""Word-level lexicon building from corpus units, and merge semantics."""

import json

from signavatar.corpus import CorpusUnit, Sentence, WordSpan
from signavatar.lexicon import load_lexicon, merge_lexicon, save_lexicon, word_entries


def _unit():
    return CorpusUnit(
        uuid="G2D1P1",
        name="篇章1段落1",
        theme="公共服務",
        film_url="/v.mp4",
        attr=[],
        sentences=[
            Sentence(
                text="我的朋友",
                glosses=["我", "朋友"],
                words=[WordSpan("我", 1500, 1800), WordSpan("朋友", 1800, 2946)],
            ),
            Sentence(
                text="我看見",
                glosses=["我", "看見"],
                words=[
                    WordSpan("我", 5000, 5600),
                    WordSpan("看/見", 5600, 6000),
                    WordSpan("我", 7000, 7400),
                ],
            ),
        ],
    )


def test_word_entries_maps_ms_to_seconds():
    entries = word_entries(_unit(), "moc_G2D1P1.json")
    assert entries["朋友"] == {
        "recording": "moc_G2D1P1.json",
        "start": 1.8,
        "end": 2.946,
        "gloss": "朋友",
        "source": "moc:G2D1P1",
        "text": "我的朋友",
    }


def test_word_entries_skips_marked_glosses():
    entries = word_entries(_unit(), "r.json")
    assert "看/見" not in entries


def test_word_entries_picks_median_duration():
    # 「我」出現 3 次,時長 300/600/400ms → 中位 400ms → start 7.0
    entries = word_entries(_unit(), "r.json")
    assert entries["我"]["start"] == 7.0
    assert entries["我"]["end"] == 7.4


def test_merge_protects_existing_by_default():
    existing = {"我": {"start": 0}}
    new = {"我": {"start": 9}, "你": {"start": 1}}
    merged, n = merge_lexicon(existing, new)
    assert merged["我"] == {"start": 0}
    assert merged["你"] == {"start": 1}
    assert n == 1


def test_merge_overwrite():
    merged, n = merge_lexicon({"我": {"start": 0}}, {"我": {"start": 9}}, overwrite=True)
    assert merged["我"] == {"start": 9}
    assert n == 1


def test_load_save_roundtrip(tmp_path):
    path = tmp_path / "lexicon.json"
    assert load_lexicon(path) == {}
    save_lexicon({"朋友": {"start": 1.8}}, path)
    assert load_lexicon(path) == {"朋友": {"start": 1.8}}
    # human-readable file: not ascii-escaped
    assert "朋友" in path.read_text(encoding="utf-8")
    assert json.loads(path.read_text(encoding="utf-8"))


def test_sentence_pairs_extracts_clean_pairs():
    from signavatar.lexicon import sentence_pairs

    pairs = sentence_pairs(_unit())
    assert {"text": "我的朋友", "glosses": ["我", "朋友"], "source": "moc:G2D1P1"} in pairs
    assert all(p["text"] and p["glosses"] for p in pairs)


def test_merge_pairs_dedupes_by_text():
    from signavatar.lexicon import merge_pairs

    existing = [{"text": "我的朋友", "glosses": ["我", "朋友"]}]
    new = [
        {"text": "我的朋友", "glosses": ["我", "朋友", "重複"]},
        {"text": "你好", "glosses": ["你", "好"]},
    ]
    merged = merge_pairs(existing, new)
    assert len(merged) == 2
    assert merged[0]["glosses"] == ["我", "朋友"]  # first wins


def test_sentence_pairs_carries_source():
    from signavatar.lexicon import sentence_pairs

    pairs = sentence_pairs(_unit())
    assert all(p["source"] == "moc:G2D1P1" for p in pairs)


def test_word_entries_strips_gloss_punctuation():
    from signavatar.lexicon import word_entries

    unit = CorpusUnit(
        uuid="U",
        name="n",
        theme="t",
        film_url="/v.mp4",
        attr=[],
        sentences=[
            Sentence(
                text="是的",
                glosses=["是，"],
                words=[WordSpan("是，", 100, 600)],
            )
        ],
    )
    entries = word_entries(unit, "r.json")
    assert "是" in entries and "是，" not in entries


def test_sentence_pairs_strip_gloss_punctuation():
    from signavatar.lexicon import sentence_pairs

    unit = CorpusUnit(
        uuid="U",
        name="n",
        theme="t",
        film_url="/v.mp4",
        attr=[],
        sentences=[
            Sentence(text="不一樣嗎", glosses=["不一樣，", "什麼？"], words=[]),
        ],
    )
    pairs = sentence_pairs(unit)
    assert pairs[0]["glosses"] == ["不一樣", "什麼"]
