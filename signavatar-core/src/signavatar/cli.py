"""Command-line entry point: `signavatar record|info`."""

from __future__ import annotations

import argparse
import sys

from signavatar.schema import load_recording


def _cmd_record(args: argparse.Namespace) -> int:
    from signavatar.capture.recorder import record  # deferred: needs camera/mediapipe

    rec = record(
        out_path=args.output,
        camera_index=args.camera,
        max_hands=args.max_hands,
        label=args.label,
    )
    if rec is None:
        print("nothing recorded, no file written")
        return 1
    print(f"saved {args.output}: {len(rec.frames)} frames, {rec.duration:.2f}s @ {rec.fps:.1f} fps")
    return 0


def _cmd_extract(args: argparse.Namespace) -> int:
    from signavatar.capture.extractor import extract  # deferred: needs mediapipe

    def report(done: int, total: int) -> None:
        suffix = f"/{total}" if total else ""
        print(f"\r  {done}{suffix} frames", end="", flush=True)

    rec = extract(
        video_path=args.video,
        out_path=args.output,
        max_hands=args.max_hands,
        label=args.label,
        mirror=not args.no_mirror,
        include_pose=not args.no_pose,
        include_face=not args.no_face,
        on_progress=report,
    )
    print()
    if rec is None:
        print("no frames in video, no file written")
        return 1
    frames_with_hands = sum(1 for f in rec.frames if f.hands)
    print(
        f"saved {args.output}: {len(rec.frames)} frames "
        f"({frames_with_hands} with hands), {rec.duration:.2f}s @ {rec.fps:.1f} fps"
    )
    return 0


def _cmd_info(args: argparse.Namespace) -> int:
    rec = load_recording(args.recording)
    frames_with_hands = sum(1 for f in rec.frames if f.hands)
    print(f"label:       {rec.label or '(none)'}")
    print(f"created:     {rec.created_at}")
    print(f"frames:      {len(rec.frames)} ({frames_with_hands} with hands)")
    print(f"duration:    {rec.duration:.2f}s @ {rec.fps:.1f} fps")
    print(f"source:      {rec.source_width}x{rec.source_height}")
    return 0


def _default_ingest_deps() -> dict:
    from signavatar.capture.extractor import extract  # deferred: needs mediapipe
    from signavatar.corpus import download_video, fetch_unit, list_units

    return {
        "fetch_unit": fetch_unit,
        "download_video": download_video,
        "extract": extract,
        "list_units": list_units,
    }


# injectable seams for tests; missing keys fall back to the real implementations
_INGEST_DEPS: dict = {}


def _ingest_dep(name: str):
    return _INGEST_DEPS.get(name) or _default_ingest_deps()[name]


def _cmd_corpus_list(args: argparse.Namespace) -> int:
    units = _ingest_dep("list_units")()
    for u in units[: args.limit] if args.limit else units:
        print(f"{u['uuid']:<12} {u.get('name', '')}")
    print(f"({len(units)} units total)")
    return 0


def _record_manifest(dest_dir, unit, extracted: bool) -> None:
    """Provenance log: recordings/moc_manifest.json maps every ingested unit
    to its origin URL, theme, and signer attributes (資料來源記錄)."""
    import json
    from datetime import datetime, timezone

    from signavatar.corpus import BASE_URL

    path = dest_dir / "moc_manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    manifest[unit.uuid] = {
        "origin": f"{BASE_URL} (文化部臺灣手語語料庫, API uuid={unit.uuid})",
        "film_url": unit.film_url,
        "theme": unit.theme,
        "name": unit.name,
        "attr": unit.attr,
        "sentences": len(unit.sentences),
        "video_extracted": extracted or manifest.get(unit.uuid, {}).get("video_extracted", False),
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
    }
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


def _cmd_corpus_pairs(args: argparse.Namespace) -> int:
    """Harvest 中文↔gloss parallel pairs from ALL corpus units (API only, no
    video download) — dialogs (type 2) included, since pairs need no tracking."""
    from pathlib import Path

    from signavatar.lexicon import load_pairs, merge_pairs, save_pairs, sentence_pairs

    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    pairs_path = dest_dir / "tsl_pairs.json"
    pairs = load_pairs(pairs_path)
    units = _ingest_dep("list_units")()
    for i, u in enumerate(units[: args.limit] if args.limit else units, 1):
        try:
            unit = _ingest_dep("fetch_unit")(u["uuid"])
        except Exception as ex:
            print(f"  {u['uuid']}: skipped ({ex})")
            continue
        pairs = merge_pairs(pairs, sentence_pairs(unit))
        _record_manifest(dest_dir, unit, extracted=False)
        if i % 20 == 0:
            save_pairs(pairs, pairs_path)  # checkpoint long harvests
            print(f"  {i}/{len(units)} units, {len(pairs)} pairs")
    save_pairs(pairs, pairs_path)
    print(f"pairs saved: {pairs_path} ({len(pairs)} pairs)")
    return 0


def _cmd_corpus_ingest(args: argparse.Namespace) -> int:
    from pathlib import Path

    from signavatar.lexicon import (
        load_lexicon,
        load_pairs,
        merge_lexicon,
        merge_pairs,
        save_lexicon,
        save_pairs,
        sentence_pairs,
        word_entries,
    )

    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    lex_path = dest_dir / "lexicon.json"
    lex = load_lexicon(lex_path)
    pairs_path = dest_dir / "tsl_pairs.json"
    pairs = load_pairs(pairs_path)

    failed: list[str] = []
    for uuid in args.uuids:
        try:
            unit = _ingest_dep("fetch_unit")(uuid)
            print(f"{uuid}: {unit.theme}/{unit.name}, {len(unit.sentences)} sentences")
            video = _ingest_dep("download_video")(unit, dest_dir)
            out = dest_dir / f"moc_{uuid}.json"
            if args.skip_extract and out.is_file():
                print(f"  extract skipped ({out.name} exists)")
            else:

                def report(done: int, total: int) -> None:
                    suffix = f"/{total}" if total else ""
                    print(f"\r  tracking {done}{suffix} frames", end="", flush=True)

                rec = _ingest_dep("extract")(
                    video, out, label=f"{unit.theme} {unit.name}", on_progress=report
                )
                print()
                if rec is None:
                    print(f"  no frames in {video.name}, skipping")
                    continue
            entries = word_entries(unit, out.name)
            lex, added = merge_lexicon(lex, entries, overwrite=args.overwrite)
            pairs = merge_pairs(pairs, sentence_pairs(unit))
            _record_manifest(dest_dir, unit, extracted=True)
            # save after every unit: a mid-batch failure must not lose progress
            save_lexicon(lex, lex_path)
            save_pairs(pairs, pairs_path)
            print(f"  {added} lexicon entries added ({len(entries)} in unit, {len(lex)} total)")
        except Exception as ex:
            failed.append(uuid)
            print(f"\n  {uuid}: FAILED ({ex}) — continuing with next unit")

    print(f"lexicon saved: {lex_path} ({len(lex)} entries, {len(pairs)} parallel pairs)")
    if failed:
        print(f"failed units: {' '.join(failed)}")
    return 0


_MOE_DEPS: dict = {}  # injectable seams for tests


def _moe_dep(name: str):
    if name in _MOE_DEPS:
        return _MOE_DEPS[name]
    if name == "fetch_all_words":
        from signavatar.moe_dict import fetch_all_words

        return fetch_all_words
    if name == "download_youtube":
        from signavatar.moe_dict import download_youtube

        return download_youtube
    from signavatar.capture.extractor import extract  # deferred: needs mediapipe

    return extract


def _record_external_manifest(dest_dir, entry_id: str, info: dict) -> None:
    """Provenance log for non-MOC sources: recordings/external_manifest.json."""
    import json
    from datetime import datetime, timezone

    path = dest_dir / "external_manifest.json"
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    fetched = datetime.now(timezone.utc).isoformat(timespec="seconds")
    manifest[entry_id] = {**info, "fetched_at": fetched}
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


def _cmd_moe_fetch(args: argparse.Namespace) -> int:
    import json
    from datetime import datetime, timezone
    from pathlib import Path

    from signavatar.moe_dict import BASE_URL

    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    words = _moe_dep("fetch_all_words")()
    data = {
        "origin": f"{BASE_URL}/signlanguage(教育部常用手語辭典,開放 API)",
        "license_note": "政府網站資料開放宣告(註明出處);影片為 YouTube 標準授權;偏文法手語",
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "words": words,
    }
    out = dest_dir / "moe_dict.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"moe_dict saved: {out} ({len(words)} words with video)")
    return 0


def _cmd_moe_ingest(args: argparse.Namespace) -> int:
    import json
    from pathlib import Path

    from signavatar.lexicon import load_lexicon, save_lexicon

    dest_dir = Path(args.dir)
    dict_path = dest_dir / "moe_dict.json"
    if not dict_path.is_file():
        print("moe_dict.json not found — run `signavatar moe fetch` first")
        return 1
    words = json.loads(dict_path.read_text(encoding="utf-8"))["words"]
    lex_path = dest_dir / "lexicon.json"
    lex = load_lexicon(lex_path)

    for word in args.words:
        if word in lex:
            print(f"{word}: already in lexicon ({lex[word].get('source', 'manual')}) — skipped")
            continue
        entry = words.get(word)
        if not entry:
            print(f"{word}: not in 教育部辭典 — skipped")
            continue
        stem = "moe_" + entry["key"].removeprefix("vocabulary/").replace("/", "_")
        try:
            video = _moe_dep("download_youtube")(entry["youtube_id"], dest_dir / f"{stem}.mp4")
            out = dest_dir / f"{stem}.json"
            rec = _moe_dep("extract")(video, out, label=f"教育部 {word}")
            if rec is None:
                print(f"{word}: no frames — skipped")
                continue
        except Exception as ex:
            print(f"{word}: FAILED ({ex}) — continuing")
            continue
        lex[word] = {
            "recording": out.name,
            "start": 0.0,
            "end": round(rec.duration, 3),
            "gloss": word,
            "source": f"moe:{entry['key']}",
            "system": "文法手語",
        }
        save_lexicon(lex, lex_path)
        _record_external_manifest(
            dest_dir,
            f"moe:{entry['key']}",
            {
                "origin": f"https://www.youtube.com/watch?v={entry['youtube_id']}",
                "word": word,
                "category": entry.get("category", ""),
                "license": "教育部開放宣告(資料)/YouTube 標準授權(影片);文法手語",
            },
        )
        print(f"{word}: ingested → {out.name} ({rec.duration:.1f}s)")
    print(f"lexicon: {len(lex)} entries")
    return 0


def _cmd_corpus_bulk(args: argparse.Namespace) -> int:
    from signavatar.bulk import bulk_corpus

    stats = bulk_corpus(args.dir, workers=args.workers, delay=args.delay, limit=args.limit)
    print(f"bulk done: {stats}")
    return 0


def _cmd_corpus_dialogues(args: argparse.Namespace) -> int:
    from signavatar.bulk import bulk_dialogues

    stats = bulk_dialogues(args.dir, workers=args.workers, delay=args.delay, limit=args.limit)
    print(f"dialogues done: {stats}")
    return 0


def _cmd_moe_bulk(args: argparse.Namespace) -> int:
    from signavatar.bulk import bulk_moe

    print("YouTube 批次下載:節流中(--delay 可調);太兇會被暫時封鎖")
    stats = bulk_moe(args.dir, workers=args.workers, delay=args.delay, limit=args.limit)
    print(f"bulk done: {stats}")
    return 0


def _backup(path):
    """詞庫改動前先留一份;檔名沿用專案既有的 .bak-<時間戳> 慣例。"""
    import shutil
    from datetime import datetime, timezone

    if not path.is_file():
        return None
    stamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    dest = path.with_suffix(f"{path.suffix}.bak-{stamp}")
    # 連續跑兩個指令會撞同一秒,直接 copy 會把前一份備份蓋掉 —— 那份才是原始檔
    n = 2
    while dest.exists():
        dest = path.with_suffix(f"{path.suffix}.bak-{stamp}-{n}")
        n += 1
    shutil.copy2(path, dest)
    return dest


def _cmd_lexicon_backfill(args: argparse.Namespace) -> int:
    """辭典影片已萃取、卻沒有任何詞條指向它的,補進詞庫。"""
    import json
    from pathlib import Path

    from signavatar.lexicon import backfill_entries, load_lexicon, merge_lexicon, save_lexicon

    dest = Path(args.dir)
    data_path = dest / args.data
    if not data_path.is_file():
        print(f"找不到 {data_path}")
        return 1
    signs = json.loads(data_path.read_text(encoding="utf-8"))["signs"]
    lex_path = dest / "lexicon.json"
    lex = load_lexicon(lex_path)

    def duration_of(recording: str):
        path = dest / recording
        if not path.is_file():
            return None
        frames = json.loads(path.read_text(encoding="utf-8")).get("frames", [])
        return round(frames[-1]["timestamp"], 3) if frames else None

    entries = backfill_entries(lex, signs, duration_of)
    if args.dry_run:
        print(f"[dry-run] 會新增 {len(entries)} 條詞條，詞庫 {len(lex)} → {len(lex) + len(entries)}")
        for word in list(entries)[:20]:
            print(f"  {word} → {entries[word]['recording']}")
        return 0
    backup = _backup(lex_path)
    lex, added = merge_lexicon(lex, entries)
    save_lexicon(lex, lex_path)
    print(f"備份 {backup.name if backup else '(無)'}")
    print(f"補登 {added} 條 → 詞庫 {len(lex)} 條")
    return 0


def _cmd_lexicon_alias(args: argparse.Namespace) -> int:
    """補上別名鍵，讓資料集的 gloss 寫法查得到影片庫的命名。"""
    from pathlib import Path

    from signavatar.lexicon import alias_entries, load_lexicon, merge_lexicon, save_lexicon

    lex_path = Path(args.dir) / "lexicon.json"
    lex = load_lexicon(lex_path)
    entries = alias_entries(lex)
    if args.dry_run:
        print(f"[dry-run] 會新增 {len(entries)} 個別名，詞庫 {len(lex)} → {len(lex) + len(entries)}")
        for alias in list(entries)[:20]:
            print(f"  {alias} → {entries[alias]['alias_of']}")
        return 0
    backup = _backup(lex_path)
    lex, added = merge_lexicon(lex, entries)
    save_lexicon(lex, lex_path)
    real = sum(1 for v in lex.values() if not v.get("alias_of"))
    print(f"備份 {backup.name if backup else '(無)'}")
    print(f"新增別名 {added} 個 → 詞庫 {len(lex)} 個鍵（實體詞條 {real}、別名 {len(lex) - real}）")
    return 0


_PLACENAMES_DEPS: dict = {}  # injectable seams for tests


def _cmd_placenames_fetch(args: argparse.Namespace) -> int:
    """Crawl the whole site's metadata into recordings/placenames.json —
    the download/extract step reads it, so re-runs need no re-crawl."""
    import json
    import time
    from datetime import datetime, timezone
    from pathlib import Path

    from signavatar.placenames import BASE_URL, fetch_all_places

    fetch_all = _PLACENAMES_DEPS.get("fetch_all_places", fetch_all_places)
    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    places = fetch_all(sleep=lambda: time.sleep(args.delay))
    data = {
        "origin": f"{BASE_URL}placenames_database.php(台灣手語地名網,張榮興台灣手語研究室)",
        "license_note": "已取得張榮興台灣手語研究室使用同意;訓練資料不對外公開、不散布影片",
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "places": [p.to_dict() for p in places],
    }
    out = dest_dir / "placenames.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    morphemes = sum(len(p.morphemes) for p in places)
    print(f"placenames saved: {out} ({len(places)} 地名, {morphemes} 字素構詞分析)")
    return 0


def _cmd_tasli_fetch(args: argparse.Namespace) -> int:
    import json
    import time
    from datetime import datetime, timezone
    from pathlib import Path

    from signavatar.tasli import BASE_URL, fetch_all

    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    entries = fetch_all(sleep=lambda: time.sleep(args.delay))
    data = {
        "origin": f"{BASE_URL}(臺灣手語新詞數位學習網,社團法人臺灣手語翻譯協會)",
        "license_note": "已取得使用同意;訓練資料不對外公開、不散布影片",
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "entries": [e.to_dict() for e in entries],
    }
    out = dest_dir / "tasli.json"
    out.write_text(json.dumps(data, ensure_ascii=False, indent=1), encoding="utf-8")
    with_word = sum(1 for e in entries if e.word_video)
    print(f"tasli saved: {out} ({len(entries)} 詞,其中 {with_word} 個有詞彙影片)")
    return 0


def _cmd_tasli_bulk(args: argparse.Namespace) -> int:
    from signavatar.bulk import bulk_tasli

    print("YouTube 批次下載:節流中(--delay 可調);太兇會被暫時封鎖")
    stats = bulk_tasli(args.dir, workers=args.workers, delay=args.delay, limit=args.limit)
    print(f"bulk done: {stats}")
    return 0


def _cmd_placenames_bulk(args: argparse.Namespace) -> int:
    from signavatar.bulk import bulk_placenames

    stats = bulk_placenames(args.dir, workers=args.workers, delay=args.delay, limit=args.limit)
    print(f"bulk done: {stats}")
    return 0


def _cmd_yt(args: argparse.Namespace) -> int:
    from pathlib import Path

    dest_dir = Path(args.dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    video = _moe_dep("download_youtube")(args.url, dest_dir / f"{args.name}.mp4")
    out = dest_dir / f"{args.name}.json"

    def report(done: int, total: int) -> None:
        suffix = f"/{total}" if total else ""
        print(f"\r  tracking {done}{suffix} frames", end="", flush=True)

    rec = _moe_dep("extract")(video, out, label=args.name, on_progress=report)
    print()
    if rec is None:
        print("no frames in video")
        return 1
    _record_external_manifest(
        dest_dir,
        f"yt:{args.name}",
        {"origin": args.url, "license": args.license_note},
    )
    print(f"saved {out.name}: {len(rec.frames)} frames, {rec.duration:.1f}s")
    return 0


def _cmd_eval(args: argparse.Namespace) -> int:
    import json
    from pathlib import Path

    from signavatar.evaluate import evaluate_pairs
    from signavatar.lexicon import load_lexicon, load_pairs
    from signavatar.translate import rule_based, select_examples, translate

    dest = Path(args.dir)
    lex = load_lexicon(dest / "lexicon.json")
    vocab = set(lex)
    pairs = load_pairs(dest / "tsl_pairs.json")
    # deterministic spread sample (no random: reproducible runs)
    if args.limit and len(pairs) > args.limit:
        step = len(pairs) // args.limit
        sample = pairs[::step][: args.limit]
    else:
        sample = pairs

    if args.llm:

        def run(text: str) -> list[str]:
            # exclude the sentence itself from few-shot (no answer leakage)
            examples = [e for e in select_examples(text, pairs) if e["text"] != text]
            return translate(text, vocab, examples=examples).glosses
    else:

        def run(text: str) -> list[str]:
            return rule_based(text, vocab).glosses

    report = evaluate_pairs(sample, vocab, run)
    mode = "LLM" if args.llm else "rules"
    print(f"[{mode}] n={report['n']} (oov-skipped {report['skipped_oov']})")
    print(f"  exact-sequence match: {report['exact']:.1%}")
    print(f"  bag-of-gloss F1:      {report['f1']:.1%}")
    print("  worst cases:")
    for w in report["worst"]:
        print(f"    「{w['text']}」")
        print(f"      ref:  {' '.join(w['ref'])}")
        print(f"      pred: {' '.join(w['pred']) or '(空)'}  (F1 {w['f1']:.2f})")
    if args.out:
        Path(args.out).write_text(
            json.dumps(report, ensure_ascii=False, indent=1, default=str), encoding="utf-8"
        )
        print(f"report saved: {args.out}")
    return 0


def _cmd_view(args: argparse.Namespace) -> int:
    import webbrowser

    from signavatar.viewer import make_server

    load_recording(args.recording)  # fail fast on bad files
    server = make_server(args.recording, port=args.port, video_path=args.video)
    url = f"http://127.0.0.1:{server.server_address[1]}/"
    print(f"viewing {args.recording} at {url}  (Ctrl-C to stop)")
    if not args.no_browser:
        webbrowser.open(url)
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="signavatar")
    sub = parser.add_subparsers(dest="command", required=True)

    p_record = sub.add_parser("record", help="record hand motion from webcam to JSON")
    p_record.add_argument("output", help="output JSON path")
    p_record.add_argument("--camera", type=int, default=0, help="camera index (default 0)")
    p_record.add_argument("--max-hands", type=int, default=2)
    p_record.add_argument("--label", default="", help="name of the sign being recorded")
    p_record.set_defaults(func=_cmd_record)

    p_extract = sub.add_parser("extract", help="extract hand motion from a video file to JSON")
    p_extract.add_argument("video", help="input video path")
    p_extract.add_argument("output", help="output JSON path")
    p_extract.add_argument("--max-hands", type=int, default=2)
    p_extract.add_argument("--label", default="", help="name of the sign in the video")
    p_extract.add_argument(
        "--no-mirror",
        action="store_true",
        help="skip the selfie flip (for footage that is already mirrored)",
    )
    p_extract.add_argument("--no-pose", action="store_true", help="skip body-pose tracking")
    p_extract.add_argument("--no-face", action="store_true", help="skip face blendshapes")
    p_extract.set_defaults(func=_cmd_extract)

    p_info = sub.add_parser("info", help="summarize a recording file")
    p_info.add_argument("recording", help="recording JSON path")
    p_info.set_defaults(func=_cmd_info)

    p_corpus = sub.add_parser("corpus", help="文化部臺灣手語語料庫: list / ingest")
    corpus_sub = p_corpus.add_subparsers(dest="corpus_command", required=True)
    p_clist = corpus_sub.add_parser("list", help="list corpus units (uuid + name)")
    p_clist.add_argument("--limit", type=int, default=0, help="show at most N units")
    p_clist.set_defaults(func=_cmd_corpus_list)
    p_cingest = corpus_sub.add_parser(
        "ingest", help="download unit video, track it, add word-level lexicon entries"
    )
    p_cingest.add_argument("uuids", nargs="+", help="corpus unit uuid(s), e.g. G2D1P1")
    p_cingest.add_argument("--dir", default="recordings", help="output dir (default recordings)")
    p_cingest.add_argument(
        "--overwrite", action="store_true", help="replace existing lexicon entries"
    )
    p_cingest.add_argument(
        "--skip-extract",
        action="store_true",
        help="reuse an existing moc_<uuid>.json instead of re-tracking the video",
    )
    p_cingest.set_defaults(func=_cmd_corpus_ingest)
    p_cpairs = corpus_sub.add_parser(
        "pairs", help="harvest 中文↔gloss parallel pairs from all units (API only, no video)"
    )
    p_cpairs.add_argument("--dir", default="recordings", help="output dir (default recordings)")
    p_cpairs.add_argument("--limit", type=int, default=0, help="harvest at most N units")
    p_cpairs.set_defaults(func=_cmd_corpus_pairs)
    p_cbulk = corpus_sub.add_parser(
        "bulk", help="ALL type-1 units: throttled downloads + parallel extraction (resumable)"
    )
    p_cbulk.add_argument("--dir", default="recordings")
    p_cbulk.add_argument("--workers", type=int, default=4, help="extraction processes")
    p_cbulk.add_argument("--delay", type=float, default=2.0, help="seconds between downloads")
    p_cbulk.add_argument("--limit", type=int, default=0)
    p_cbulk.set_defaults(func=_cmd_corpus_bulk)
    p_cdlg = corpus_sub.add_parser(
        "dialogues",
        help="ALL type-2 units: 依 Speaker 裁半邊畫面再走單人管線 (resumable)",
    )
    p_cdlg.add_argument("--dir", default="recordings")
    p_cdlg.add_argument("--workers", type=int, default=4, help="extraction processes")
    p_cdlg.add_argument("--delay", type=float, default=2.0, help="seconds between downloads")
    p_cdlg.add_argument("--limit", type=int, default=0, help="first N units only (0 = all)")
    p_cdlg.set_defaults(func=_cmd_corpus_dialogues)

    p_moe = sub.add_parser("moe", help="教育部常用手語辭典: fetch metadata / ingest words")
    moe_sub = p_moe.add_subparsers(dest="moe_command", required=True)
    p_mfetch = moe_sub.add_parser("fetch", help="fetch all word metadata (~15,770 entries)")
    p_mfetch.add_argument("--dir", default="recordings")
    p_mfetch.set_defaults(func=_cmd_moe_fetch)
    p_mingest = moe_sub.add_parser(
        "ingest", help="download word videos, extract, add 文法手語-tagged lexicon entries"
    )
    p_mingest.add_argument("words", nargs="+", help="詞彙 (must exist in moe_dict.json)")
    p_mingest.add_argument("--dir", default="recordings")
    p_mingest.set_defaults(func=_cmd_moe_ingest)
    p_mbulk = moe_sub.add_parser(
        "bulk",
        help="gap-fill lexicon from MOE videos, ranked by corpus-gloss frequency (resumable)",
    )
    p_mbulk.add_argument("--dir", default="recordings")
    p_mbulk.add_argument("--workers", type=int, default=4)
    p_mbulk.add_argument(
        "--delay", type=float, default=6.0, help="seconds between YouTube downloads (ban safety)"
    )
    p_mbulk.add_argument("--limit", type=int, default=200, help="words per run (default 200)")
    p_mbulk.set_defaults(func=_cmd_moe_bulk)

    p_lex = sub.add_parser("lexicon", help="詞庫維護: 補登既有影片 / 補別名鍵")
    lex_sub = p_lex.add_subparsers(dest="lexicon_command", required=True)
    p_lbf = lex_sub.add_parser(
        "backfill", help="已萃取但沒進詞庫的辭典影片,補成詞條(不覆蓋既有詞條)"
    )
    p_lbf.add_argument("--dir", default="recordings")
    p_lbf.add_argument("--data", default="twtsl_backfill.json", help="來源資料檔(相對 --dir)")
    p_lbf.add_argument("--dry-run", action="store_true", help="只列出會新增什麼,不寫檔")
    p_lbf.set_defaults(func=_cmd_lexicon_backfill)
    p_lal = lex_sub.add_parser(
        "alias", help="補別名鍵: 變體後綴 美國_A→美國、行政區 南投縣→南投、異體字 你→妳"
    )
    p_lal.add_argument("--dir", default="recordings")
    p_lal.add_argument("--dry-run", action="store_true", help="只列出會新增什麼,不寫檔")
    p_lal.set_defaults(func=_cmd_lexicon_alias)

    p_pn = sub.add_parser("placenames", help="台灣手語地名網: fetch metadata / bulk ingest")
    pn_sub = p_pn.add_subparsers(dest="placenames_command", required=True)
    p_pfetch = pn_sub.add_parser(
        "fetch", help="crawl all 19 counties + detail pages into placenames.json"
    )
    p_pfetch.add_argument("--dir", default="recordings")
    p_pfetch.add_argument(
        "--delay", type=float, default=0.5, help="seconds between page requests"
    )
    p_pfetch.set_defaults(func=_cmd_placenames_fetch)
    p_pbulk = pn_sub.add_parser(
        "bulk", help="download + extract every place-name clip, add lexicon entries (resumable)"
    )
    p_pbulk.add_argument("--dir", default="recordings")
    p_pbulk.add_argument("--workers", type=int, default=4, help="extraction processes")
    p_pbulk.add_argument("--delay", type=float, default=1.5, help="seconds between downloads")
    p_pbulk.add_argument("--limit", type=int, default=0, help="first N places only (0 = all)")
    p_pbulk.set_defaults(func=_cmd_placenames_bulk)

    p_ts = sub.add_parser("tasli", help="臺灣手語新詞數位學習網: fetch metadata / bulk ingest")
    ts_sub = p_ts.add_subparsers(dest="tasli_command", required=True)
    p_tfetch = ts_sub.add_parser("fetch", help="掃索引頁與詞頁,產出 tasli.json")
    p_tfetch.add_argument("--dir", default="recordings")
    p_tfetch.add_argument("--delay", type=float, default=0.5, help="seconds between page requests")
    p_tfetch.set_defaults(func=_cmd_tasli_fetch)
    p_tbulk = ts_sub.add_parser(
        "bulk", help="下載詞彙影片 + 萃取 + 加詞條 (resumable)"
    )
    p_tbulk.add_argument("--dir", default="recordings")
    p_tbulk.add_argument("--workers", type=int, default=4)
    p_tbulk.add_argument(
        "--delay", type=float, default=6.0, help="seconds between YouTube downloads (ban safety)"
    )
    p_tbulk.add_argument("--limit", type=int, default=0)
    p_tbulk.set_defaults(func=_cmd_tasli_bulk)

    p_yt = sub.add_parser("yt", help="download a YouTube video and extract it into the library")
    p_yt.add_argument("url", help="YouTube URL")
    p_yt.add_argument("name", help="output stem (recordings/<name>.mp4/.json)")
    p_yt.add_argument("--dir", default="recordings")
    p_yt.add_argument(
        "--license-note", default="未確認", help="license provenance note (e.g. CC-BY)"
    )
    p_yt.set_defaults(func=_cmd_yt)

    p_eval = sub.add_parser("eval", help="score translation vs corpus reference glosses")
    p_eval.add_argument("--dir", default="recordings")
    p_eval.add_argument("--limit", type=int, default=0, help="sample size (0 = all pairs)")
    p_eval.add_argument("--llm", action="store_true", help="evaluate the LLM path (uses quota)")
    p_eval.add_argument("--out", default="", help="save JSON report to this path")
    p_eval.set_defaults(func=_cmd_eval)

    p_view = sub.add_parser("view", help="open a recording in the web viewer")
    p_view.add_argument("recording", help="recording JSON path")
    p_view.add_argument("--port", type=int, default=0, help="port (default: pick a free one)")
    p_view.add_argument("--no-browser", action="store_true", help="don't open the browser")
    p_view.add_argument("--video", help="source video to show beside the skeleton")
    p_view.set_defaults(func=_cmd_view)

    args = parser.parse_args(argv)
    return args.func(args)


if __name__ == "__main__":
    sys.exit(main())
