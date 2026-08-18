"""Bulk ingestion orchestration (workers=0 inline mode, injected deps)."""

import json

from signavatar.bulk import bulk_corpus, bulk_moe, rank_moe_words
from signavatar.corpus import CorpusUnit, Sentence, WordSpan


def _unit(uuid):
    return CorpusUnit(
        uuid=uuid,
        name="篇章1段落1",
        theme="測試",
        film_url=f"/v_{uuid}.mp4",
        attr=[],
        sentences=[
            Sentence(
                text=f"我的朋友{uuid}",
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
        frames=[Frame(index=0, timestamp=0.0, hands=[]), Frame(index=1, timestamp=2.0, hands=[])],
        label=kwargs.get("label", ""),
    )
    save_recording(rec, out_path)
    return rec


def test_bulk_corpus_end_to_end_and_resume(tmp_path):
    downloads = []

    def fake_download(unit, dest_dir, **kwargs):
        dest = tmp_path / f"moc_{unit.uuid}.mp4"
        dest.write_bytes(b"MP4")
        downloads.append(unit.uuid)
        return dest

    deps = {
        "list_units": lambda: [
            {"uuid": "U1", "type": "1", "name": "a"},
            {"uuid": "U2", "type": "1", "name": "b"},
            {"uuid": "D1", "type": "2", "name": "dialog"},  # skipped: two signers
        ],
        "fetch_unit": _unit,
        "download_video": fake_download,
        "extract": _fake_extract,
    }
    stats = bulk_corpus(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats["extracted"] == 2
    assert downloads == ["U1", "U2"]  # dialog not downloaded
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["我"]["source"] in ("moc:U1", "moc:U2")
    manifest = json.loads((tmp_path / "moc_manifest.json").read_text(encoding="utf-8"))
    assert manifest["U1"]["video_extracted"] is True
    pairs = json.loads((tmp_path / "tsl_pairs.json").read_text(encoding="utf-8"))
    assert len(pairs) == 2

    # resume: nothing left to download or extract
    stats2 = bulk_corpus(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats2["extracted"] == 0
    assert downloads == ["U1", "U2"]


def test_rank_moe_words_gap_frequency_first(tmp_path):
    moe_words = {
        "覺得": {"key": "vocabulary/02/1", "youtube_id": "a", "is_common": False},
        "高興": {"key": "vocabulary/02/2", "youtube_id": "b", "is_common": True},
        "已有": {"key": "vocabulary/02/3", "youtube_id": "c", "is_common": True},
    }
    lexicon = {"已有": {"start": 0}}
    pairs = [
        {"text": "x", "glosses": ["覺得", "覺得", "高興"], "source": "moc:X"},
    ]
    ranked = rank_moe_words(moe_words, lexicon, pairs)
    assert ranked[0] == "覺得"  # freq 2, gap
    assert ranked[1] == "高興"  # freq 1
    assert "已有" not in ranked  # already in lexicon


def test_bulk_moe_ingests_with_tag(tmp_path):
    (tmp_path / "moe_dict.json").write_text(
        json.dumps(
            {
                "origin": "x",
                "words": {
                    "覺得": {
                        "key": "vocabulary/02/0001",
                        "word": "覺得",
                        "youtube_id": "vid1",
                        "is_common": True,
                        "category": "c",
                    }
                },
            },
            ensure_ascii=False,
        ),
        encoding="utf-8",
    )

    def fake_yt(url_or_id, dest):
        dest.write_bytes(b"MP4")
        return dest

    deps = {"download_youtube": fake_yt, "extract": _fake_extract}
    stats = bulk_moe(tmp_path, words=["覺得"], workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats["extracted"] == 1
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["覺得"]["system"] == "文法手語"
    assert lex["覺得"]["end"] == 2.0  # duration read back from the recording
