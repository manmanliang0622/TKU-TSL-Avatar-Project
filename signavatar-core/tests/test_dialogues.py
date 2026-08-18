"""對話單元:依 Speaker 裁半邊畫面,詞條只收該演繹者打的句子。"""

import json

import pytest

from signavatar.bulk import bulk_dialogues
from signavatar.corpus import CorpusUnit, Sentence, WordSpan, unit_from_api
from signavatar.lexicon import word_entries


def _dialogue(uuid="G1C1"):
    return CorpusUnit(
        uuid=uuid, name="對話1", theme="交通旅遊", film_url=f"/v_{uuid}.mp4",
        attr=["演繹者1:11", "演繹者2:13"],
        sentences=[
            Sentence(text="請問你去國外旅遊時，", glosses=["問", "出國"],
                     words=[WordSpan("問", 860, 1785), WordSpan("出國", 1785, 3125)],
                     speaker="L"),
            Sentence(text="可以用Line聯絡。", glosses=["Line", "聯絡"],
                     words=[WordSpan("Line", 21624, 22400), WordSpan("聯絡", 22400, 23190)],
                     speaker="R"),
        ],
    )


def test_unit_from_api_reads_speaker():
    unit = unit_from_api({
        "uuid": "G1C1", "name": "對話1", "film_url": "/v.mp4",
        "apiData": [{"Text": "x", "Hand": ["問"], "Speaker": "L",
                     "wordList": [{"Word": "問", "T1": 1, "T2": 2}]}],
    })
    assert unit.sentences[0].speaker == "L"


def test_narrative_sentences_have_no_speaker():
    unit = unit_from_api({
        "uuid": "G2D1P1", "name": "篇章", "film_url": "/v.mp4",
        "apiData": [{"Text": "x", "Hand": ["我"], "wordList": [{"Word": "我", "T1": 1, "T2": 2}]}],
    })
    assert unit.sentences[0].speaker == ""


def test_word_entries_filters_by_speaker():
    unit = _dialogue()
    left = word_entries(unit, "moc_G1C1_L.json", speaker="L")
    right = word_entries(unit, "moc_G1C1_R.json", speaker="R")
    assert set(left) == {"問", "出國"} and set(right) == {"Line", "聯絡"}
    # 詞條必須指向自己那半邊的錄影，否則播出去是另一位演繹者的手
    assert left["問"]["recording"] == "moc_G1C1_L.json"
    assert left["問"]["speaker"] == "L"
    # 時間戳是時間軸上的，空間裁切不動它
    assert (left["問"]["start"], left["問"]["end"]) == (0.86, 1.785)


def test_word_entries_without_speaker_keeps_old_behaviour():
    entries = word_entries(_dialogue(), "moc_G1C1.json")
    assert set(entries) == {"問", "出國", "Line", "聯絡"}
    assert "speaker" not in entries["問"]


def _fake_extract(video_path, out_path, **kwargs):
    from signavatar.schema import Frame, Recording, save_recording

    rec = Recording(fps=30.0, source_width=960, source_height=1080,
                    created_at="2026-08-18T00:00:00+00:00",
                    frames=[Frame(index=0, timestamp=0.0, hands=[]),
                            Frame(index=1, timestamp=2.0, hands=[])],
                    label=kwargs.get("label", ""))
    save_recording(rec, out_path)
    return rec


def test_bulk_dialogues_extracts_both_halves_and_resumes(tmp_path):
    crops, downloads = [], []

    def fake_download(unit, dest_dir, **kw):
        dest = tmp_path / f"moc_{unit.uuid}.mp4"
        dest.write_bytes(b"MP4")
        downloads.append(unit.uuid)
        return dest

    def spy_extract(video, out, **kw):
        crops.append((out.name, kw.get("crop")))
        return _fake_extract(video, out, **kw)

    deps = {
        "list_units": lambda: [
            {"uuid": "G1C1", "type": "2"},
            {"uuid": "G2D1P1", "type": "1"},   # 敘事單元不歸這條路管
        ],
        "fetch_unit": lambda u: _dialogue(u),
        "download_video": fake_download,
        "extract": spy_extract,
    }
    stats = bulk_dialogues(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert downloads == ["G1C1"]           # type-1 沒被抓進來
    assert stats["extracted"] == 2         # 左右各一份
    assert sorted(crops) == [("moc_G1C1_L.json", (0.0, 0.5)),
                             ("moc_G1C1_R.json", (0.5, 1.0))]

    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["問"]["recording"] == "moc_G1C1_L.json"
    assert lex["Line"]["recording"] == "moc_G1C1_R.json"
    man = json.loads((tmp_path / "moc_manifest.json").read_text(encoding="utf-8"))
    assert man["G1C1"]["dialogue_speakers"] == ["L", "R"]

    crops.clear()
    stats2 = bulk_dialogues(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert (stats2["downloaded"], stats2["extracted"]) == (0, 0)
    assert crops == []


def test_bulk_dialogues_never_clobbers_existing_entries(tmp_path):
    (tmp_path / "lexicon.json").write_text(
        json.dumps({"問": {"recording": "0001_問.json", "start": 0, "end": 1,
                           "source": "twtsl:1"}}, ensure_ascii=False), encoding="utf-8")
    deps = {
        "list_units": lambda: [{"uuid": "G1C1", "type": "2"}],
        "fetch_unit": lambda u: _dialogue(u),
        "download_video": lambda unit, d, **kw: (tmp_path / f"moc_{unit.uuid}.mp4").write_bytes(b"MP4"),
        "extract": _fake_extract,
    }
    bulk_dialogues(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["問"]["source"] == "twtsl:1"


def test_extract_rejects_a_crop_outside_the_frame(tmp_path):
    cv2 = pytest.importorskip("cv2")
    import numpy as np

    path = tmp_path / "v.mp4"
    w = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"mp4v"), 10, (64, 48))
    for _ in range(3):
        w.write(np.zeros((48, 64, 3), dtype=np.uint8))
    w.release()
    from signavatar.capture.extractor import extract

    with pytest.raises(ValueError, match="crop"):
        extract(path, tmp_path / "o.json", crop=(0.5, 0.4))
