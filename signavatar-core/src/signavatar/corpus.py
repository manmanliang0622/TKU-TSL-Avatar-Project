"""文化部臺灣手語語料庫 (tslcorpus.moc.gov.tw) API client.

Read-only access to the public corpus API: unit listing, per-unit detail
(Chinese text + TSL gloss sequence + per-word millisecond timestamps), and
video download. Non-commercial research use; downloaded material must not
be redistributed.

All network entry points take an injectable transport so tests never touch
the network.
"""

from __future__ import annotations

import json
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

BASE_URL = "https://tslcorpus.moc.gov.tw"
_TIMEOUT_S = 60


@dataclass
class WordSpan:
    gloss: str
    t1_ms: int
    t2_ms: int


@dataclass
class Sentence:
    text: str
    glosses: list[str]
    words: list[WordSpan]
    # 對話單元(type=2)兩位演繹者同框,逐句標「L」/「R」= 畫面左/右半邊。
    # 敘事單元只有一位,這裡是 ""。
    speaker: str = ""


@dataclass
class CorpusUnit:
    uuid: str
    name: str
    theme: str
    film_url: str
    attr: list[str] = field(default_factory=list)
    sentences: list[Sentence] = field(default_factory=list)


def _post_json(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode(),
        headers={"Content-Type": "application/json"},
        method="POST",
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
        return json.loads(res.read())


def _get_bytes(url: str) -> bytes:
    with urllib.request.urlopen(url, timeout=_TIMEOUT_S * 10) as res:
        return res.read()


def _checked(response: dict) -> dict | list:
    if response.get("code") != 1:
        raise RuntimeError(f"corpus API error: {response.get('msg', response)}")
    return response["data"]


def unit_from_api(data: dict) -> CorpusUnit:
    sentences = [
        Sentence(
            text=s.get("Text", ""),
            glosses=list(s.get("Hand") or []),
            words=[
                WordSpan(gloss=w["Word"], t1_ms=int(w["T1"]), t2_ms=int(w["T2"]))
                for w in (s.get("wordList") or [])
            ],
            speaker=(s.get("Speaker") or "").strip(),
        )
        for s in data.get("apiData") or []
    ]
    return CorpusUnit(
        uuid=data["uuid"],
        name=data.get("name", ""),
        theme=(data.get("theme_data") or {}).get("name", ""),
        film_url=data.get("film_url", ""),
        attr=list(data.get("attr") or []),
        sentences=sentences,
    )


def list_units(fetch: Callable[[str, dict], dict] = _post_json) -> list[dict]:
    """All corpus units as raw dicts: {uuid, name, type} (+ id)."""
    return _checked(fetch("/api/corpus/getCorpusList", {}))


def fetch_unit(uuid: str, fetch: Callable[[str, dict], dict] = _post_json) -> CorpusUnit:
    data = _checked(fetch("/api/corpus/findCorpusDetailByUuid", {"uuid": uuid}))
    return unit_from_api(data)


def download_video(
    unit: CorpusUnit,
    dest_dir: str | Path,
    fetch_bytes: Callable[[str], bytes] = _get_bytes,
) -> Path:
    """Download the unit's video as moc_<uuid>.mp4; keep an existing file."""
    dest = Path(dest_dir) / f"moc_{unit.uuid}.mp4"
    if dest.is_file():
        return dest
    data = fetch_bytes(BASE_URL + unit.film_url)
    dest.write_bytes(data)
    return dest
