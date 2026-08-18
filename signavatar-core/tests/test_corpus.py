"""MOC corpus client: parsing and injected-transport fetches (no network)."""

import json
from pathlib import Path

import pytest

from signavatar.corpus import CorpusUnit, download_video, fetch_unit, list_units, unit_from_api

FIXTURE = json.loads((Path(__file__).parent / "fixtures" / "moc_detail.json").read_text())


def test_unit_from_api_parses_sentences():
    unit = unit_from_api(FIXTURE)
    assert unit.uuid == "G2D1P1"
    assert unit.name == "篇章1段落1"
    assert unit.theme == "公共服務"
    assert unit.film_url == "/upload/24/web/video/Bphwq023LKHuHx1y.mp4"
    assert len(unit.sentences) == 2
    s = unit.sentences[0]
    assert s.text.startswith("我的朋友")
    assert s.glosses[:2] == ["我", "朋友"]
    assert s.words[0].gloss == "我"
    assert s.words[0].t1_ms == 1500
    assert s.words[0].t2_ms == 1800


def test_fetch_unit_uses_injected_fetch():
    calls = []

    def fake(path, payload):
        calls.append((path, payload))
        return {"code": 1, "data": FIXTURE}

    unit = fetch_unit("G2D1P1", fetch=fake)
    assert isinstance(unit, CorpusUnit)
    assert calls == [("/api/corpus/findCorpusDetailByUuid", {"uuid": "G2D1P1"})]


def test_list_units_returns_data_list():
    def fake(path, payload):
        assert path == "/api/corpus/getCorpusList"
        return {"code": 1, "data": [{"uuid": "G2D1P1", "name": "篇章1段落1", "type": "1"}]}

    units = list_units(fetch=fake)
    assert units == [{"uuid": "G2D1P1", "name": "篇章1段落1", "type": "1"}]


def test_download_video_writes_file_and_skips_existing(tmp_path):
    unit = unit_from_api(FIXTURE)
    calls = []

    def fake_bytes(url):
        calls.append(url)
        return b"MP4DATA"

    dest = download_video(unit, tmp_path, fetch_bytes=fake_bytes)
    assert dest == tmp_path / "moc_G2D1P1.mp4"
    assert dest.read_bytes() == b"MP4DATA"
    assert calls == ["https://tslcorpus.moc.gov.tw/upload/24/web/video/Bphwq023LKHuHx1y.mp4"]

    # second call: file exists, no re-download
    dest2 = download_video(unit, tmp_path, fetch_bytes=fake_bytes)
    assert dest2 == dest
    assert len(calls) == 1


def test_fetch_unit_raises_on_error_code():
    def fake(path, payload):
        return {"code": 0, "msg": "boom"}

    with pytest.raises(RuntimeError, match="boom"):
        fetch_unit("XXX", fetch=fake)
