"""中文 → TSL gloss 翻譯層.

Two backends behind one `translate()` entry point:

- `rule_based()`: greedy vocabulary segmentation + word-order rules
  (time words fronted, negation clause-final, function words dropped)
  from the packaged data/tsl_rules.json. Deterministic, offline.
- `llm_translate()`: prompts the local `claude` CLI with a TSL grammar
  summary, MOC-corpus few-shot pairs, and the available vocabulary;
  output is validated to stay inside the vocabulary, otherwise the
  caller falls back to the rules.

Both return a `Translation` whose glosses are guaranteed to exist in the
lexicon vocabulary, so the composer can always play the result.
"""

from __future__ import annotations

import json
import re
import shutil
import subprocess
from collections.abc import Callable
from dataclasses import asdict, dataclass, field
from functools import lru_cache
from importlib import resources

_SPLIT_RE = re.compile(r"[\s,，。.!！?？;；:：、]+")
_LLM_TIMEOUT_S = 90


class LLMUnavailable(RuntimeError):
    """claude CLI missing or failed to run."""


@dataclass
class Translation:
    glosses: list[str]
    question: str = "none"  # none | yesno | wh
    negation: bool = False
    unknown: list[str] = field(default_factory=list)
    source: str = "rules"  # rules | llm

    def as_dict(self) -> dict:
        return asdict(self)


@lru_cache(maxsize=1)
def load_rules() -> dict:
    text = resources.files("signavatar").joinpath("data/tsl_rules.json").read_text("utf-8")
    return json.loads(text)


def segment(
    text: str, vocab: set[str], synonyms: dict[str, str], extra: set[str] | None = None
) -> tuple[list[str], list[str]]:
    """Greedy longest-match segmentation.

    Matches against vocab ∪ synonyms-keys ∪ extra; synonym matches map to
    their vocabulary gloss. Returns (tokens, unknown-characters). Tokens
    from `extra` (function/negation markers outside the vocab) pass
    through as-is so the caller can classify them.
    """
    candidates = set(vocab) | set(synonyms) | (extra or set())
    max_len = max((len(c) for c in candidates), default=1)
    tokens: list[str] = []
    unknown: list[str] = []
    for chunk in filter(None, _SPLIT_RE.split(text.strip())):
        i = 0
        while i < len(chunk):
            matched = None
            for length in range(min(max_len, len(chunk) - i), 0, -1):
                cand = chunk[i : i + length]
                if cand in candidates:
                    matched = cand
                    break
            if matched:
                tokens.append(synonyms.get(matched, matched))
                i += len(matched)
            else:
                unknown.append(chunk[i])
                i += 1
    return tokens, unknown


def rule_based(text: str, vocab: set[str], rules: dict | None = None) -> Translation:
    rules = rules or load_rules()
    time_words = set(rules["time_words"])
    question_words = set(rules["question_words"])
    negation_words = set(rules["negation_words"])
    function_words = set(rules["function_words"])
    synonyms = {k: v for k, v in rules["synonyms"].items() if v in vocab}

    extra = function_words | negation_words
    tokens, unknown = segment(text, vocab, synonyms, extra=extra)

    question = "none"
    if any(q in text for q in question_words):
        question = "wh"
    elif "嗎" in text or "?" in text or "?" in text:
        question = "yesno"

    negation = any(n in text for n in negation_words)

    front: list[str] = []
    body: list[str] = []
    tail: list[str] = []
    for tok in tokens:
        if tok in negation_words:
            if tok in vocab:
                tail.append(tok)
            continue  # negation outside vocab: flag only
        if tok in function_words and tok not in vocab:
            continue
        if tok not in vocab:
            unknown.append(tok)
            continue
        if tok in time_words:
            front.append(tok)
        else:
            body.append(tok)

    # dedup unknown, keep order
    seen: set[str] = set()
    unknown = [u for u in unknown if not (u in seen or seen.add(u))]
    return Translation(
        glosses=front + body + tail,
        question=question,
        negation=negation,
        unknown=unknown,
        source="rules",
    )


# static fallback few-shot (MOC corpus unit G2D1P1) — used when no harvested
# parallel pairs are available
_STATIC_EXAMPLES = [
    {
        "text": "我的朋友半年前突然車禍,",
        "glosses": ["我", "朋友", "六個月", "以前", "突然", "車禍"],
    },
    {"text": "造成雙耳極重度的聽損。", "glosses": ["雙耳", "聽損", "程度", "重", "很"]},
    {
        "text": "他在醫院治療期間,發現自己無法聽見。",
        "glosses": ["他", "醫院", "治療", "期間", "發現", "自己", "聽", "沒辦法"],
    },
]


def select_examples(text: str, pairs: list[dict], k: int = 6) -> list[dict]:
    """Pick the k parallel pairs sharing the most characters with the input —
    cheap similarity that keeps the prompt's few-shot on-topic."""
    chars = set(text)

    def score(pair: dict) -> int:
        return len(chars & set(pair["text"]))

    return sorted(pairs, key=score, reverse=True)[:k]


def build_prompt(text: str, vocab: set[str], examples: list[dict] | None = None) -> str:
    vocab_list = ", ".join(sorted(vocab))
    shots = (examples or []) + _STATIC_EXAMPLES
    shots = shots[: max(6, len(examples or []))]
    few_shot = "\n".join(f"中文:{p['text']}\nTSL:{' '.join(p['glosses'])}" for p in shots)
    return f"""你是台灣手語(TSL)翻譯員,把中文句子翻成自然台灣手語的 gloss 序列。

TSL 文法規則:
- 基本語序 SVO,主題可前置(topic-comment)。
- 時間詞放句首;否定詞(沒辦法、沒有等)放述語後面。
- 疑問詞(什麼、誰、哪裡)留在原位或句尾;是非問句以表情標記,不打「嗎」。
- 省略「的、了、嗎、呢、是、在」等虛詞。
- 動結式先結果後動作(例:滅火 → 火 滅)。

範例(取自文化部臺灣手語語料庫):
{few_shot}

可用的 gloss 詞彙表(只能用這些,一個都不能自創):
{vocab_list}

把下面的中文翻成 TSL。概念在詞彙表裡找不到對應 gloss 時,放進 unknown,不要硬湊。
只輸出一個 JSON 物件,格式:
{{"glosses": ["..."], "question": "none|yesno|wh", "negation": true|false, "unknown": ["..."]}}

中文:{text}"""


def _run_claude(prompt: str) -> str:
    exe = shutil.which("claude")
    if not exe:
        raise LLMUnavailable("claude CLI not found on PATH")
    try:
        proc = subprocess.run(
            [exe, "-p", prompt],
            capture_output=True,
            text=True,
            timeout=_LLM_TIMEOUT_S,
            stdin=subprocess.DEVNULL,
        )
    except subprocess.TimeoutExpired as ex:
        raise LLMUnavailable("claude CLI timed out") from ex
    if proc.returncode != 0:
        raise LLMUnavailable(f"claude CLI failed: {proc.stderr.strip()[:200]}")
    return proc.stdout


def _extract_json(raw: str) -> dict | None:
    start, end = raw.find("{"), raw.rfind("}")
    if start < 0 or end <= start:
        return None
    try:
        obj = json.loads(raw[start : end + 1])
    except json.JSONDecodeError:
        return None
    return obj if isinstance(obj, dict) else None


def llm_translate(
    text: str,
    vocab: set[str],
    runner: Callable[[str], str] | None = None,
    examples: list[dict] | None = None,
) -> Translation | None:
    """Translate via LLM; None when the response is unusable (caller falls back)."""
    runner = runner or _run_claude
    obj = _extract_json(runner(build_prompt(text, vocab, examples=examples)))
    if obj is None:
        return None
    from signavatar.lexicon import clean_gloss

    raw_glosses = obj.get("glosses")
    if not isinstance(raw_glosses, list) or not all(isinstance(g, str) for g in raw_glosses):
        return None
    glosses = [g for g in (clean_gloss(g) for g in raw_glosses) if g]
    if not set(glosses) <= vocab:
        return None
    question = obj.get("question", "none")
    if question not in ("none", "yesno", "wh"):
        question = "none"
    unknown = obj.get("unknown")
    unknown = [str(u) for u in unknown] if isinstance(unknown, list) else []
    return Translation(
        glosses=glosses,
        question=question,
        negation=bool(obj.get("negation")),
        unknown=unknown,
        source="llm",
    )


def translate(
    text: str,
    vocab: set[str],
    use_llm: bool = True,
    runner: Callable[[str], str] | None = None,
    examples: list[dict] | None = None,
) -> Translation:
    """LLM first (when enabled), rule-based fallback. Always playable glosses."""
    if use_llm:
        try:
            result = llm_translate(text, vocab, runner=runner, examples=examples)
            if result is not None:
                return result
        except LLMUnavailable:
            pass
    return rule_based(text, vocab)
