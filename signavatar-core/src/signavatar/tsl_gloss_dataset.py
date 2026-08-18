"""Utilities for the local Chinese-to-TSL-gloss instruction dataset."""

from __future__ import annotations

import argparse
import csv
import json
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[2]
DATASET_ROOT = PROJECT_ROOT / "data" / "tsl_gloss_dataset"
DEFAULT_RAW_CSV_PATH = DATASET_ROOT / "raw" / "tsl_sentences.csv"
DEFAULT_JSONL_PATH = DATASET_ROOT / "processed" / "gemma_train.jsonl"

INSTRUCTION = "請將中文句子轉成台灣自然手語語序，並標出語法資訊。"

CSV_FIELDS = [
    "id",
    "source",
    "zh_sentence",
    "tsl_gloss",
    "subject",
    "object",
    "time",
    "topic",
    "verb",
    "verb_type",
    "agreement",
    "question_type",
    "negation",
    "nonmanual",
    "notes",
]

REQUIRED_FIELDS = ["id", "zh_sentence", "tsl_gloss"]
VERB_TYPES = {"plain", "agreement", "spatial", "unknown"}
QUESTION_TYPES = {"none", "yesno", "wh"}
BOOL_VALUES = {"true": True, "false": False}


def _clean(value: str | None) -> str:
    return (value or "").strip()


def _parse_bool(value: str, row_id: str) -> bool:
    normalized = value.strip().lower()
    if normalized not in BOOL_VALUES:
        raise ValueError(f"{row_id}: invalid negation {value!r}; use true or false")
    return BOOL_VALUES[normalized]


def _validate_header(fieldnames: list[str] | None) -> None:
    if fieldnames != CSV_FIELDS:
        expected = ", ".join(CSV_FIELDS)
        actual = ", ".join(fieldnames or [])
        raise ValueError(f"CSV header mismatch. Expected: {expected}. Actual: {actual}")


def _validate_row(row: dict[str, str], row_number: int, seen_ids: set[str]) -> None:
    row_id = _clean(row.get("id")) or f"row {row_number}"
    missing = [field for field in REQUIRED_FIELDS if not _clean(row.get(field))]
    if missing:
        raise ValueError(f"{row_id}: missing required fields: {', '.join(missing)}")
    if row_id in seen_ids:
        raise ValueError(f"{row_id}: duplicate id")
    seen_ids.add(row_id)

    verb_type = _clean(row.get("verb_type")) or "unknown"
    if verb_type not in VERB_TYPES:
        raise ValueError(f"{row_id}: invalid verb_type {verb_type!r}")

    question_type = _clean(row.get("question_type")) or "none"
    if question_type not in QUESTION_TYPES:
        raise ValueError(f"{row_id}: invalid question_type {question_type!r}")

    _parse_bool(_clean(row.get("negation")) or "false", row_id)


def _to_gemma_record(row: dict[str, str]) -> dict[str, str]:
    row_id = _clean(row["id"])
    output = {
        "gloss": _clean(row["tsl_gloss"]),
        "subject": _clean(row.get("subject")) or "none",
        "object": _clean(row.get("object")) or "none",
        "time": _clean(row.get("time")) or "none",
        "topic": _clean(row.get("topic")) or "none",
        "verb": _clean(row.get("verb")) or "none",
        "verb_type": _clean(row.get("verb_type")) or "unknown",
        "agreement": _clean(row.get("agreement")) or "none",
        "question_type": _clean(row.get("question_type")) or "none",
        "negation": _parse_bool(_clean(row.get("negation")) or "false", row_id),
        "nonmanual": _clean(row.get("nonmanual")) or "none",
    }
    return {
        "instruction": INSTRUCTION,
        "input": _clean(row["zh_sentence"]),
        "output": json.dumps(output, ensure_ascii=False, separators=(",", ":")),
    }


def convert_csv_to_jsonl(input_path: str | Path, output_path: str | Path) -> int:
    """Validate a TSL gloss CSV and write Gemma instruction-tuning JSONL."""
    input_path = Path(input_path)
    output_path = Path(output_path)
    seen_ids: set[str] = set()
    records: list[dict[str, str]] = []

    with input_path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        _validate_header(reader.fieldnames)
        for row_number, row in enumerate(reader, start=2):
            _validate_row(row, row_number, seen_ids)
            records.append(_to_gemma_record(row))

    output_path.parent.mkdir(parents=True, exist_ok=True)
    with output_path.open("w", encoding="utf-8", newline="\n") as f:
        for record in records:
            f.write(json.dumps(record, ensure_ascii=False, separators=(",", ":")) + "\n")

    return len(records)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--input", type=Path, default=DEFAULT_RAW_CSV_PATH)
    parser.add_argument("--output", type=Path, default=DEFAULT_JSONL_PATH)
    args = parser.parse_args(argv)

    count = convert_csv_to_jsonl(args.input, args.output)
    print(f"Wrote {count} records to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
