"""Word-level sign lexicon: build entries from corpus units, merge, load/save.

The lexicon file (recordings/lexicon.json) maps a gloss to a time segment of
a recording. Legacy entries ({recording, start, end}) stay valid; corpus-built
entries add gloss/source/text metadata. Merging never clobbers existing
(possibly hand-annotated) entries unless overwrite is requested.
"""

from __future__ import annotations

import json
import re
import statistics
from pathlib import Path

from signavatar.corpus import CorpusUnit

# glosses carrying annotation markers (hand switching, compounds, repeats)
# are not clean single signs — leave them out of the word lexicon
_MARKERS = set("→/;+~ ")

# corpus glosses carry sentence punctuation (「是，」「什麼？」) — strip it
_PUNCT = "，。？！?!,.、;；:：…「」『』()（）"


def clean_gloss(gloss: str) -> str:
    return gloss.strip().strip(_PUNCT)


def word_entries(
    unit: CorpusUnit, recording_name: str, speaker: str | None = None
) -> dict[str, dict]:
    """One lexicon entry per clean gloss; repeated glosses take the
    occurrence whose duration is closest to the median (a typical token,
    not a clipped or dragged-out one).

    speaker: 對話單元的錄影是裁一半、只有一位演繹者,詞條必須只收那一位打的
    句子——否則會指到另一半的錄影,播出去是別人的手。
    """
    occurrences: dict[str, list[tuple[int, int, str]]] = {}
    for sentence in unit.sentences:
        if speaker is not None and sentence.speaker != speaker:
            continue
        for w in sentence.words:
            gloss = clean_gloss(w.gloss)
            if not gloss or any(ch in _MARKERS for ch in gloss):
                continue
            if w.t2_ms <= w.t1_ms:
                continue
            occurrences.setdefault(gloss, []).append((w.t1_ms, w.t2_ms, sentence.text))

    entries: dict[str, dict] = {}
    for gloss, occs in occurrences.items():
        median = statistics.median(t2 - t1 for t1, t2, _ in occs)
        t1, t2, text = min(occs, key=lambda o: abs((o[1] - o[0]) - median))
        entries[gloss] = {
            "recording": recording_name,
            "start": round(t1 / 1000, 3),
            "end": round(t2 / 1000, 3),
            "gloss": gloss,
            "source": f"moc:{unit.uuid}",
            "text": text,
        }
        # source 維持 moc:<uuid>,出處頁才查得到單元記錄;演繹者另開欄位
        if speaker:
            entries[gloss]["speaker"] = speaker
    return entries


def sentence_pairs(unit: CorpusUnit) -> list[dict]:
    """中文↔gloss parallel pairs (LLM few-shot material). Marked glosses pass
    through unchanged — examples show real corpus annotation. Every pair
    records its provenance (source unit uuid)."""
    pairs = []
    for s in unit.sentences:
        glosses = [g for g in (clean_gloss(g) for g in s.glosses) if g]
        if s.text.strip() and glosses:
            pairs.append({"text": s.text, "glosses": glosses, "source": f"moc:{unit.uuid}"})
    return pairs


def merge_pairs(existing: list[dict], new: list[dict]) -> list[dict]:
    """Append new pairs, deduped by text; first occurrence wins."""
    seen = {p["text"] for p in existing}
    merged = list(existing)
    for p in new:
        if p["text"] not in seen:
            merged.append(p)
            seen.add(p["text"])
    return merged


def merge_lexicon(existing: dict, new: dict, overwrite: bool = False) -> tuple[dict, int]:
    """Merge new entries into existing; returns (merged, added_or_replaced)."""
    merged = dict(existing)
    changed = 0
    for name, entry in new.items():
        if name in merged and not overwrite:
            continue
        merged[name] = entry
        changed += 1
    return merged, changed


# ── 別名層 ────────────────────────────────────────────────────────────
# 詞庫的鍵是「影片庫怎麼命名」，資料集的 gloss 是「語料庫怎麼標註」，兩者對不上
# 的部分其實不缺影片,只是查不到。composer.js 的 build() 是 exact key lookup,
# 查不到就整個詞不動;tokenize() 更糟,會逐字貪婪切分,用短詞拼出「錯的」手勢
# (南投 → 投、美國 → 美/國)。所以在詞庫裡補上別名鍵指向同一段錄影,前端不必動。
_VARIANT_SUFFIX = re.compile(r"_(?:[A-Z]|S|\d+)$")     # 美國_A、會_S
_ADMIN_SUFFIX = re.compile(r"(縣|市|鄉|鎮|區|村|里)$")    # 南投縣 → 南投
# 語料庫用異體字、影片庫用正體;只做整字取代,不做組合以免爆量
_CHAR_VARIANTS = [("台", "臺"), ("你", "妳"), ("他", "她")]


def alias_entries(lex: dict) -> dict[str, dict]:
    """回傳「新別名鍵 → 詞條副本」,只含目前查不到的鍵。

    別名一律帶 `alias_of` 欄位,方便統計時排除(不然來源計數會灌水)。
    同一個別名有多個候選時取排序後第一個,讓每次產生的結果一致。
    """
    canonical = {k: v for k, v in lex.items() if not v.get("alias_of")}
    candidates: dict[str, list[str]] = {}

    def offer(alias: str, target: str) -> None:
        if alias and alias not in lex:
            candidates.setdefault(alias, []).append(target)

    for key, entry in sorted(canonical.items()):
        offer(_VARIANT_SUFFIX.sub("", key).rstrip("_"), key)
        # 行政區後綴只對地名詞條套用,而且剩下的部分要 ≥2 字。否則「一日千里」
        # 會生出「一日千」、「夜市」會生出「夜」—— 後者更糟:短別名鍵會被
        # tokenize 的貪婪切分拿去拼別的詞,把錯的手勢帶進不相干的句子。
        if str(entry.get("source", "")).startswith("placename:"):
            base = _ADMIN_SUFFIX.sub("", key)
            if len(base) >= 2:
                offer(base, key)
        for plain, variant in _CHAR_VARIANTS:
            if plain in key:
                offer(key.replace(plain, variant), key)

    return {
        alias: {**canonical[sorted(targets)[0]], "alias_of": sorted(targets)[0]}
        for alias, targets in candidates.items()
    }


def backfill_entries(lex: dict, signs: list[dict], duration_of) -> dict[str, dict]:
    """辭典影片已萃取但沒進詞庫的,補成詞條(不覆蓋既有鍵)。

    signs = [{id, recording, words, description}];`words` 含辭典正式名與同義
    索引名,逐一嘗試。`duration_of(recording)` 回傳秒數,查不到該檔就回 None。
    """
    entries: dict[str, dict] = {}
    for sign in signs:
        free = [w for w in sign["words"] if w not in lex and w not in entries]
        if not free:
            continue
        end = duration_of(sign["recording"])
        if end is None:
            continue
        for word in free:
            entries[word] = {
                "recording": sign["recording"],
                "start": 0.0,
                "end": end,
                "gloss": word,
                "source": f"twtsl:{sign['id']}",
                "text": sign.get("description", ""),
            }
    return entries


def load_pairs(path: str | Path) -> list[dict]:
    path = Path(path)
    if not path.is_file():
        return []
    return json.loads(path.read_text(encoding="utf-8"))


def save_pairs(pairs: list[dict], path: str | Path) -> None:
    Path(path).write_text(json.dumps(pairs, ensure_ascii=False, indent=1), encoding="utf-8")


def load_lexicon(path: str | Path) -> dict:
    path = Path(path)
    if not path.is_file():
        return {}
    return json.loads(path.read_text(encoding="utf-8"))


def save_lexicon(lex: dict, path: str | Path) -> None:
    Path(path).write_text(json.dumps(lex, ensure_ascii=False, indent=1), encoding="utf-8")
