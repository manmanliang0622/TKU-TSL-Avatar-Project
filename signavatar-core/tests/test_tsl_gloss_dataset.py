import csv
import json
from pathlib import Path

import pytest

from signavatar.tsl_gloss_dataset import (
    CSV_FIELDS,
    DEFAULT_JSONL_PATH,
    DEFAULT_RAW_CSV_PATH,
    convert_csv_to_jsonl,
)


def _valid_row(**overrides):
    row = {
        "id": "TSL0001",
        "source": "synthetic_manual",
        "zh_sentence": "我昨天買了一台新電腦",
        "tsl_gloss": "昨天 電腦 我 買",
        "subject": "我",
        "object": "電腦",
        "time": "昨天",
        "topic": "電腦",
        "verb": "買",
        "verb_type": "plain",
        "agreement": "word_order",
        "question_type": "none",
        "negation": "false",
        "nonmanual": "none",
        "notes": "時間在前；主題優先",
    }
    row.update(overrides)
    return row


def _write_csv(path: Path, rows: list[dict[str, str]]) -> None:
    with path.open("w", encoding="utf-8-sig", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def test_convert_csv_to_jsonl_writes_gemma_records(tmp_path):
    csv_path = tmp_path / "input.csv"
    jsonl_path = tmp_path / "output.jsonl"
    _write_csv(csv_path, [_valid_row()])

    assert convert_csv_to_jsonl(csv_path, jsonl_path) == 1

    record = json.loads(jsonl_path.read_text(encoding="utf-8").splitlines()[0])
    output = json.loads(record["output"])
    assert record["input"] == "我昨天買了一台新電腦"
    assert output["gloss"] == "昨天 電腦 我 買"
    assert output["negation"] is False


def test_convert_csv_to_jsonl_rejects_invalid_rows(tmp_path):
    csv_path = tmp_path / "input.csv"
    jsonl_path = tmp_path / "output.jsonl"
    _write_csv(
        csv_path,
        [
            _valid_row(negation="no"),
            _valid_row(id="TSL0002", verb_type="motion", question_type="maybe"),
        ],
    )

    with pytest.raises(ValueError, match="invalid"):
        convert_csv_to_jsonl(csv_path, jsonl_path)


def test_bundled_tsl_gloss_dataset_has_1000_rows_and_valid_jsonl():
    with DEFAULT_RAW_CSV_PATH.open(encoding="utf-8-sig", newline="") as f:
        rows = list(csv.DictReader(f))

    ids = [row["id"] for row in rows]
    assert len(rows) == 1000
    assert ids[0] == "TSL0001"
    assert ids[-1] == "TSL1000"
    assert len(set(ids)) == 1000
    assert all(None not in row for row in rows)

    assert convert_csv_to_jsonl(DEFAULT_RAW_CSV_PATH, DEFAULT_JSONL_PATH) == 1000
    lines = DEFAULT_JSONL_PATH.read_text(encoding="utf-8").splitlines()
    records = [json.loads(line) for line in lines]
    outputs = [json.loads(record["output"]) for record in records]
    assert len(records) == 1000
    assert records[0]["input"] == "我昨天買了一台新電腦"
    assert outputs[0]["gloss"] == "昨天 電腦 我 買"
    assert records[-1]["input"]
    assert outputs[-1]["gloss"]
