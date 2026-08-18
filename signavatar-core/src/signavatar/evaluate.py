"""Translation quality evaluation against corpus reference glosses.

The MOC parallel pairs double as a held-out test set: feed the Chinese
side through the translation layer and score the predicted gloss sequence
against the corpus annotation. Sentences whose reference contains glosses
outside the current vocabulary are excluded — a vocabulary-constrained
translator can never produce them, so they would only measure lexicon
coverage (reported separately) rather than translation quality.
"""

from __future__ import annotations

from collections import Counter
from collections.abc import Callable


def gloss_f1(pred: list[str], ref: list[str]) -> tuple[float, float, float]:
    """Bag-of-gloss precision/recall/F1 (multiset overlap)."""
    if not pred or not ref:
        return (0.0, 0.0, 0.0)
    overlap = sum((Counter(pred) & Counter(ref)).values())
    p = overlap / len(pred)
    r = overlap / len(ref)
    f = 2 * p * r / (p + r) if p + r else 0.0
    return (p, r, f)


def evaluate_pairs(
    pairs: list[dict],
    vocab: set[str],
    translate_fn: Callable[[str], list[str]],
    worst_k: int = 5,
) -> dict:
    """Score translate_fn over pairs; returns aggregate metrics + worst cases."""
    scored = []
    skipped_oov = 0
    for pair in pairs:
        ref = pair["glosses"]
        if not ref or not set(ref) <= vocab:
            skipped_oov += 1
            continue
        pred = translate_fn(pair["text"])
        _, _, f = gloss_f1(pred, ref)
        scored.append(
            {"text": pair["text"], "ref": ref, "pred": pred, "f1": f, "exact": pred == ref}
        )
    n = len(scored)
    if not n:
        return {"n": 0, "exact": 0.0, "f1": 0.0, "skipped_oov": skipped_oov, "worst": []}
    return {
        "n": n,
        "exact": sum(s["exact"] for s in scored) / n,
        "f1": sum(s["f1"] for s in scored) / n,
        "skipped_oov": skipped_oov,
        "worst": sorted(scored, key=lambda s: s["f1"])[:worst_k],
    }
