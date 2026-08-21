"""CLI `signavatar corpus list|ingest` with injected corpus/extract deps."""

import json

from signavatar import cli
from signavatar.corpus import CorpusUnit, Sentence, WordSpan


def _unit():
    return CorpusUnit(
        uuid="G2D1P1",
        name="篇章1段落1",
        theme="公共服務",
        film_url="/v.mp4",
        attr=[],
        sentences=[
            Sentence(
                text="我的朋友",
                glosses=["我", "朋友"],
                words=[WordSpan("我", 1500, 1800), WordSpan("朋友", 1800, 2946)],
            )
        ],
    )


def _fake_extract(video_path, out_path, **kwargs):
    from signavatar.schema import Frame, Recording, save_recording

    rec = Recording(
        fps=30.0,
        source_width=640,
        source_height=480,
        created_at="2026-07-05T00:00:00+00:00",
        frames=[Frame(index=0, timestamp=0.0, hands=[])],
        label=kwargs.get("label", ""),
    )
    save_recording(rec, out_path)
    return rec


def _patch(monkeypatch, tmp_path):
    def fake_download(unit, dest_dir, **kwargs):
        dest = tmp_path / f"moc_{unit.uuid}.mp4"
        dest.write_bytes(b"MP4")
        return dest

    monkeypatch.setitem(cli._INGEST_DEPS, "fetch_unit", lambda uuid: _unit())
    monkeypatch.setitem(cli._INGEST_DEPS, "download_video", fake_download)
    monkeypatch.setitem(cli._INGEST_DEPS, "extract", _fake_extract)


def test_corpus_ingest_builds_lexicon(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    rc = cli.main(["corpus", "ingest", "G2D1P1", "--dir", str(tmp_path)])
    assert rc == 0
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["朋友"]["start"] == 1.8
    assert lex["朋友"]["recording"] == "moc_G2D1P1.json"
    assert (tmp_path / "moc_G2D1P1.json").is_file()


def test_corpus_ingest_preserves_existing_entries(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    (tmp_path / "lexicon.json").write_text(json.dumps({"朋友": {"start": 99}}), encoding="utf-8")
    rc = cli.main(["corpus", "ingest", "G2D1P1", "--dir", str(tmp_path)])
    assert rc == 0
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["朋友"] == {"start": 99}  # untouched
    assert "我" in lex


def test_corpus_list(monkeypatch, capsys):
    monkeypatch.setitem(
        cli._INGEST_DEPS,
        "list_units",
        lambda: [{"uuid": "G2D1P1", "name": "篇章1段落1", "type": "1"}],
    )
    rc = cli.main(["corpus", "list", "--limit", "1"])
    assert rc == 0
    out = capsys.readouterr().out
    assert "G2D1P1" in out


def test_corpus_ingest_writes_manifest_and_pairs(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)
    rc = cli.main(["corpus", "ingest", "G2D1P1", "--dir", str(tmp_path)])
    assert rc == 0
    manifest = json.loads((tmp_path / "moc_manifest.json").read_text(encoding="utf-8"))
    assert manifest["G2D1P1"]["theme"] == "公共服務"
    assert manifest["G2D1P1"]["film_url"] == "/v.mp4"
    assert manifest["G2D1P1"]["origin"].startswith("https://tslcorpus.moc.gov.tw")
    pairs = json.loads((tmp_path / "tsl_pairs.json").read_text(encoding="utf-8"))
    assert pairs and pairs[0]["source"] == "moc:G2D1P1"


def test_corpus_pairs_harvests_without_video(monkeypatch, tmp_path, capsys):
    monkeypatch.setitem(
        cli._INGEST_DEPS,
        "list_units",
        lambda: [{"uuid": "G2D1P1", "name": "篇章1段落1", "type": "1"}],
    )
    monkeypatch.setitem(cli._INGEST_DEPS, "fetch_unit", lambda uuid: _unit())
    rc = cli.main(["corpus", "pairs", "--dir", str(tmp_path)])
    assert rc == 0
    pairs = json.loads((tmp_path / "tsl_pairs.json").read_text(encoding="utf-8"))
    assert {"text": "我的朋友", "glosses": ["我", "朋友"], "source": "moc:G2D1P1"} in pairs
    assert not (tmp_path / "moc_G2D1P1.mp4").exists()  # no video download


def test_corpus_ingest_survives_unit_failure(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)

    def flaky_fetch(uuid):
        if uuid == "BADUNIT":
            raise RuntimeError("HTTP Error 500")
        return _unit()

    monkeypatch.setitem(cli._INGEST_DEPS, "fetch_unit", flaky_fetch)
    rc = cli.main(["corpus", "ingest", "BADUNIT", "G2D1P1", "--dir", str(tmp_path)])
    assert rc == 0  # bad unit skipped, good unit still ingested
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert "朋友" in lex


def test_corpus_ingest_saves_incrementally(monkeypatch, tmp_path):
    _patch(monkeypatch, tmp_path)

    def exploding_fetch_second(uuid):
        if uuid == "SECOND":
            raise RuntimeError("boom")
        return _unit()

    monkeypatch.setitem(cli._INGEST_DEPS, "fetch_unit", exploding_fetch_second)
    rc = cli.main(["corpus", "ingest", "G2D1P1", "SECOND", "--dir", str(tmp_path)])
    assert rc == 0
    # first unit's entries must be on disk even though the second failed
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert "朋友" in lex
