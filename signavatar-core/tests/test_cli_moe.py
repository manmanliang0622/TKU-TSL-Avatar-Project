"""CLI `signavatar moe fetch|ingest` and `signavatar yt` with injected deps."""

import json

from signavatar import cli

WORDS = {
    "今天": {
        "key": "vocabulary/01/0002",
        "word": "今天",
        "description": "today",
        "youtube_id": "abcDEF12345",
        "is_common": True,
        "is_advance": False,
        "category": "數字、日期",
    }
}


def _fake_extract(video_path, out_path, **kwargs):
    from signavatar.schema import Frame, Recording, save_recording

    rec = Recording(
        fps=30.0,
        source_width=640,
        source_height=480,
        created_at="2026-07-05T00:00:00+00:00",
        frames=[
            Frame(index=0, timestamp=0.0, hands=[]),
            Frame(index=1, timestamp=1.5, hands=[]),
        ],
        label=kwargs.get("label", ""),
    )
    save_recording(rec, out_path)
    return rec


def _patch(monkeypatch, tmp_path):
    def fake_download(url_or_id, dest):
        dest.write_bytes(b"MP4")
        return dest

    monkeypatch.setitem(cli._MOE_DEPS, "fetch_all_words", lambda: WORDS)
    monkeypatch.setitem(cli._MOE_DEPS, "download_youtube", fake_download)
    monkeypatch.setitem(cli._MOE_DEPS, "extract", _fake_extract)


def test_moe_fetch_saves_dict(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    rc = cli.main(["moe", "fetch", "--dir", str(tmp_path)])
    assert rc == 0
    data = json.loads((tmp_path / "moe_dict.json").read_text(encoding="utf-8"))
    assert data["words"]["今天"]["youtube_id"] == "abcDEF12345"
    assert "special.moe.gov.tw" in data["origin"]


def test_moe_ingest_builds_tagged_entry(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    cli.main(["moe", "fetch", "--dir", str(tmp_path)])
    rc = cli.main(["moe", "ingest", "今天", "--dir", str(tmp_path)])
    assert rc == 0
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    entry = lex["今天"]
    assert entry["system"] == "文法手語"
    assert entry["source"] == "moe:vocabulary/01/0002"
    assert entry["recording"] == "moe_01_0002.json"
    assert entry["end"] == 1.5
    manifest = json.loads((tmp_path / "external_manifest.json").read_text(encoding="utf-8"))
    assert "moe:vocabulary/01/0002" in manifest


def test_moe_ingest_skips_existing_lexicon_word(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    cli.main(["moe", "fetch", "--dir", str(tmp_path)])
    (tmp_path / "lexicon.json").write_text(
        json.dumps({"今天": {"start": 1, "source": "moc:X"}}), encoding="utf-8"
    )
    rc = cli.main(["moe", "ingest", "今天", "--dir", str(tmp_path)])
    assert rc == 0
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["今天"] == {"start": 1, "source": "moc:X"}  # natural entry untouched


def test_yt_ingest_downloads_and_extracts(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    rc = cli.main(
        [
            "yt",
            "https://www.youtube.com/watch?v=XYZ",
            "ntnu_lesson01",
            "--dir",
            str(tmp_path),
            "--license-note",
            "CC-BY(YouTube 標示)",
        ]
    )
    assert rc == 0
    assert (tmp_path / "ntnu_lesson01.json").is_file()
    manifest = json.loads((tmp_path / "external_manifest.json").read_text(encoding="utf-8"))
    assert manifest["yt:ntnu_lesson01"]["license"] == "CC-BY(YouTube 標示)"
    assert manifest["yt:ntnu_lesson01"]["origin"] == "https://www.youtube.com/watch?v=XYZ"
