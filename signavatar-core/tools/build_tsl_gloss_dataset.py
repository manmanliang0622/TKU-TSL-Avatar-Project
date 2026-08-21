"""Build the bundled 1000-row Chinese-to-TSL-gloss dataset.

The first rows can be seeded from an existing CSV. Additional rows are
deterministically synthesized from grammar templates so the dataset can be
rebuilt without network access.
"""

from __future__ import annotations

import argparse
import csv
import itertools
import sys
from pathlib import Path


PROJECT_ROOT = Path(__file__).resolve().parents[1]
SRC_ROOT = PROJECT_ROOT / "src"
sys.path.insert(0, str(SRC_ROOT))

from signavatar.tsl_gloss_dataset import CSV_FIELDS  # noqa: E402


DEFAULT_SEED = (
    Path.home()
    / "OneDrive"
    / "文件"
    / "生成加前端"
    / "tsl_gloss_dataset"
    / "data"
    / "raw"
    / "tsl_sentences.csv"
)
DEFAULT_OUTPUT = PROJECT_ROOT / "data" / "tsl_gloss_dataset" / "raw" / "tsl_sentences.csv"


TIMES = [
    "今天",
    "明天",
    "昨天",
    "早上",
    "下午",
    "晚上",
    "下星期",
    "現在",
    "等一下",
    "星期六",
]
PEOPLE = ["我", "你", "他", "她", "我們", "你們", "老師", "學生", "媽媽", "爸爸"]
OBJECTS = ["書", "手機", "咖啡", "水", "作業", "電影", "訊息", "照片", "雨傘", "錢包"]
PLACES = ["學校", "台北", "公司", "醫院", "圖書館", "夜市", "教室", "房間", "公園", "車站"]
VERBS = ["買", "看", "喝", "帶", "寫", "找", "喜歡", "記得", "忘記", "討厭"]
COLORS = ["紅", "黑", "藍", "白", "黃", "綠", "紫", "灰", "粉紅", "咖啡色"]
ADJECTIVES = ["漂亮", "重要", "便宜", "貴", "大", "小", "冷", "熱", "安靜", "吵"]
AGREEMENT_VERBS = ["給", "告訴", "問", "教", "提醒", "幫", "送", "傳", "借", "還"]


def _read_seed(path: Path) -> list[dict[str, str]]:
    if not path.is_file():
        return []
    with path.open("r", encoding="utf-8-sig", newline="") as f:
        reader = csv.DictReader(f)
        if reader.fieldnames != CSV_FIELDS:
            raise ValueError(f"seed CSV header mismatch: {path}")
        return [{field: (row.get(field) or "") for field in CSV_FIELDS} for row in reader]


def _row(
    zh_sentence: str,
    tsl_gloss: str,
    subject: str,
    object_: str,
    time: str,
    topic: str,
    verb: str,
    verb_type: str,
    agreement: str,
    question_type: str,
    negation: bool,
    nonmanual: str,
    notes: str,
) -> dict[str, str]:
    return {
        "id": "",
        "source": "synthetic_template",
        "zh_sentence": zh_sentence,
        "tsl_gloss": tsl_gloss,
        "subject": subject,
        "object": object_,
        "time": time or "none",
        "topic": topic or "none",
        "verb": verb,
        "verb_type": verb_type,
        "agreement": agreement,
        "question_type": question_type,
        "negation": "true" if negation else "false",
        "nonmanual": nonmanual,
        "notes": notes,
    }


def _template_rows():
    for time, person, obj, verb in itertools.product(TIMES, PEOPLE, OBJECTS, VERBS):
        yield _row(
            f"{person}{time}{verb}{obj}",
            f"{time} {obj} {person} {verb}",
            person,
            obj,
            time,
            obj,
            verb,
            "plain",
            "word_order",
            "none",
            False,
            "none",
            "時間在前；受語作主題",
        )
        yield _row(
            f"{person}{time}沒有{verb}{obj}",
            f"{time} {obj} {person} {verb} 沒有",
            person,
            obj,
            time,
            obj,
            verb,
            "plain",
            "word_order",
            "none",
            True,
            "head_shake",
            "時間在前；否定後置",
        )

    for time, person, place in itertools.product(TIMES, PEOPLE, PLACES):
        yield _row(
            f"{person}{time}去{place}",
            f"{time} {place} {person} 去",
            person,
            place,
            time,
            place,
            "去",
            "spatial",
            "spatial_direction",
            "none",
            False,
            "none",
            "時間地點先建立",
        )
        yield _row(
            f"{person}{time}不去{place}",
            f"{time} {place} {person} 去 不",
            person,
            place,
            time,
            place,
            "去",
            "spatial",
            "word_order",
            "none",
            True,
            "head_shake",
            "否定放動詞後",
        )

    for person, place in itertools.product(PEOPLE, PLACES):
        yield _row(
            f"{person}住在哪裡",
            f"{person} 住 哪裡",
            person,
            "哪裡",
            "",
            "none",
            "住",
            "spatial",
            "spatial_location",
            "wh",
            False,
            "wh_expression",
            "位置疑問詞句尾",
        )
        yield _row(
            f"{person}家在{place}",
            f"{place} {person} 家 在",
            f"{person}家",
            place,
            "",
            place,
            "在",
            "spatial",
            "spatial_location",
            "none",
            False,
            "none",
            "地點作主題",
        )

    for obj, color, adjective in itertools.product(OBJECTS, COLORS, ADJECTIVES):
        yield _row(
            f"{color}色的{obj}很{adjective}",
            f"{obj} {color} {adjective}",
            "none",
            obj,
            "",
            obj,
            adjective,
            "plain",
            "word_order",
            "none",
            False,
            "none",
            "修飾語放名詞後",
        )

    for giver, receiver, obj, verb in itertools.product(PEOPLE, PEOPLE, OBJECTS, AGREEMENT_VERBS):
        if giver == receiver:
            continue
        yield _row(
            f"{giver}{verb}{receiver}{obj}",
            f"{receiver} {obj} {giver} {verb}",
            giver,
            receiver,
            "",
            receiver,
            verb,
            "agreement",
            "directional_movement",
            "none",
            False,
            "eye_gaze",
            "受者先建立；方向或眼神標示呼應",
        )


def build_rows(seed_rows: list[dict[str, str]], total: int) -> list[dict[str, str]]:
    rows = seed_rows[:total]
    seen = {(row["zh_sentence"], row["tsl_gloss"]) for row in rows}
    for candidate in _template_rows():
        key = (candidate["zh_sentence"], candidate["tsl_gloss"])
        if key in seen:
            continue
        rows.append(candidate)
        seen.add(key)
        if len(rows) == total:
            break
    if len(rows) != total:
        raise RuntimeError(f"only built {len(rows)} rows, expected {total}")
    for index, row in enumerate(rows, 1):
        row["id"] = f"TSL{index:04d}"
    return rows


def write_csv(rows: list[dict[str, str]], output: Path) -> None:
    output.parent.mkdir(parents=True, exist_ok=True)
    with output.open("w", encoding="utf-8", newline="") as f:
        writer = csv.DictWriter(f, fieldnames=CSV_FIELDS)
        writer.writeheader()
        writer.writerows(rows)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--seed", type=Path, default=DEFAULT_SEED)
    parser.add_argument("--output", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--total", type=int, default=1000)
    args = parser.parse_args(argv)

    rows = build_rows(_read_seed(args.seed), args.total)
    write_csv(rows, args.output)
    print(f"Wrote {len(rows)} rows to {args.output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
