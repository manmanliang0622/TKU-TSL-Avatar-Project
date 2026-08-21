"""zh→TSL gloss translation: greedy segmentation, reorder rules, LLM fallback."""

import json

import pytest

from signavatar.translate import (
    LLMUnavailable,
    Translation,
    build_prompt,
    llm_translate,
    rule_based,
    segment,
    translate,
)

VOCAB = {
    "我",
    "朋友",
    "六個月",
    "以前",
    "突然",
    "車禍",
    "聽",
    "沒辦法",
    "醫院",
    "你",
    "好",
    "什麼",
}


def test_segment_greedy_with_synonyms():
    tokens, unknown = segment("我半年聽不到", VOCAB, {"半年": "六個月"})
    assert tokens == ["我", "六個月", "聽"]
    assert unknown  # 不/到 have no gloss


def test_segment_longest_match_wins():
    vocab = {"財神", "財神到"}
    tokens, _ = segment("財神到", vocab, {})
    assert tokens == ["財神到"]


def test_rule_based_time_fronting_and_negation_final():
    t = rule_based("我以前無法聽", VOCAB)
    assert t.glosses == ["以前", "我", "聽", "沒辦法"]
    assert t.negation is True
    assert t.question == "none"
    assert t.source == "rules"


def test_rule_based_question_detection():
    assert rule_based("你好嗎", VOCAB).question == "yesno"
    assert rule_based("你聽什麼", VOCAB).question == "wh"


def test_rule_based_drops_function_words():
    t = rule_based("我的朋友", VOCAB)
    assert t.glosses == ["我", "朋友"]


def test_translation_as_dict_roundtrips_json():
    t = Translation(glosses=["我"], question="none", negation=False, unknown=[], source="rules")
    assert json.loads(json.dumps(t.as_dict())) == t.as_dict()


def test_build_prompt_contains_vocab_and_examples():
    p = build_prompt("你好", {"你", "好"})
    assert "你, 好" in p or "你、好" in p or '"你"' in p or "你," in p
    assert "沒辦法" in p  # few-shot example present
    assert "JSON" in p


def test_llm_translate_valid_response():
    def runner(prompt):
        return json.dumps(
            {"glosses": ["你", "好"], "question": "yesno", "negation": False, "unknown": []}
        )

    t = llm_translate("你好嗎", {"你", "好"}, runner=runner)
    assert t is not None
    assert t.glosses == ["你", "好"]
    assert t.source == "llm"


def test_llm_translate_rejects_out_of_vocab():
    def runner(prompt):
        return json.dumps({"glosses": ["外星詞"], "question": "none", "negation": False})

    assert llm_translate("你好", {"你", "好"}, runner=runner) is None


def test_llm_translate_rejects_garbage():
    assert llm_translate("你好", {"你"}, runner=lambda p: "not json at all") is None


def test_translate_falls_back_to_rules():
    def broken(prompt):
        raise LLMUnavailable("no claude")

    t = translate("我以前無法聽", VOCAB, runner=broken)
    assert t.source == "rules"
    assert t.glosses == ["以前", "我", "聽", "沒辦法"]


def test_translate_uses_llm_when_available():
    def runner(prompt):
        return json.dumps({"glosses": ["我", "聽"], "question": "none", "negation": True})

    t = translate("我聽不到", VOCAB, runner=runner)
    assert t.source == "llm"
    assert t.negation is True


def test_translate_use_llm_false_skips_runner():
    def exploding(prompt):  # pragma: no cover - must not be called
        raise AssertionError("runner called despite use_llm=False")

    t = translate("我聽", VOCAB, use_llm=False, runner=exploding)
    assert t.source == "rules"


def test_llm_extracts_json_from_wrapped_text():
    def runner(prompt):
        body = '{"glosses": ["我"], "question": "none", "negation": false}'
        return f"Here you go:\n```json\n{body}\n```"

    t = llm_translate("我", {"我"}, runner=runner)
    assert t is not None and t.glosses == ["我"]


def test_rule_based_unknown_reported():
    t = rule_based("我吃飯", VOCAB)
    assert t.glosses == ["我"]
    assert t.unknown


@pytest.mark.parametrize("empty", ["", "   ", "??!"])
def test_rule_based_empty(empty):
    t = rule_based(empty, VOCAB)
    assert t.glosses == []


def test_select_examples_prefers_char_overlap():
    from signavatar.translate import select_examples

    pairs = [
        {"text": "今天天氣很好", "glosses": ["今天", "天氣", "好"]},
        {"text": "我的朋友車禍", "glosses": ["我", "朋友", "車禍"]},
        {"text": "去商店買東西", "glosses": ["商店", "買"]},
    ]
    picked = select_examples("我朋友出車禍了", pairs, k=2)
    assert picked[0]["text"] == "我的朋友車禍"
    assert len(picked) == 2


def test_build_prompt_includes_selected_examples():
    from signavatar.translate import build_prompt

    examples = [{"text": "今天天氣很好", "glosses": ["今天", "天氣", "好"]}]
    p = build_prompt("你好", {"你", "好"}, examples=examples)
    assert "今天天氣很好" in p
    assert "今天 天氣 好" in p


def test_translate_passes_examples_to_prompt():
    from signavatar.translate import translate

    seen = {}

    def runner(prompt):
        seen["prompt"] = prompt
        return '{"glosses": ["我"], "question": "none", "negation": false}'

    examples = [{"text": "獨特例句甲", "glosses": ["我"]}]
    translate("我", {"我"}, runner=runner, examples=examples)
    assert "獨特例句甲" in seen["prompt"]


def test_llm_translate_normalizes_punctuated_glosses():
    def runner(prompt):
        return '{"glosses": ["什麼？", "不一樣，"], "question": "wh", "negation": false}'

    t = llm_translate("有什麼不一樣", {"什麼", "不一樣"}, runner=runner)
    assert t is not None
    assert t.glosses == ["什麼", "不一樣"]
