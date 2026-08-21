"""Bulk ingestion: throttled downloads + parallel extraction, resumable.

Downloads run sequentially with jittered delays — politeness toward the
corpus server and YouTube (aggressive bulk pulls get IP-banned). MediaPipe
extraction is the real bottleneck, so it fans out to a process pool.
Every phase skips files that already exist, so an interrupted run resumes
where it left off.
"""

from __future__ import annotations

import json
import random
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
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


def _extract_worker(
    video_path: str, out_path: str, label: str, crop: tuple[float, float] | None = None
) -> tuple[str, int]:
    """Top-level (picklable) worker: runs MediaPipe extraction in a subprocess."""
    from signavatar.capture.extractor import extract

    rec = extract(video_path, out_path, label=label, crop=crop)
    return out_path, len(rec.frames) if rec else 0


def _jittered(delay: float) -> float:
    return delay * (0.6 + 0.8 * random.random())


def _record_manifest(dest_dir: Path, filename: str, entry_id: str, info: dict) -> None:
    path = dest_dir / filename
    manifest = json.loads(path.read_text(encoding="utf-8")) if path.is_file() else {}
    manifest[entry_id] = {**manifest.get(entry_id, {}), **info}
    path.write_text(json.dumps(manifest, ensure_ascii=False, indent=1), encoding="utf-8")


def _run_extractions(jobs: list[tuple], workers: int, deps: dict, log) -> int:
    """jobs = [(video, out_json, label)] or [(video, out_json, label, crop)];
    returns number extracted."""
    jobs = [j if len(j) == 4 else (*j, None) for j in jobs]
    done = 0
    if workers <= 0:  # inline (tests inject extract)
        extract = deps.get("extract")
        if extract is None:
            from signavatar.capture.extractor import extract  # pragma: no cover
        for video, out, label, crop in jobs:
            if extract(video, out, label=label, crop=crop) is not None:
                done += 1
        return done
    with ProcessPoolExecutor(max_workers=workers) as pool:
        futures = {
            pool.submit(_extract_worker, str(video), str(out), label, crop): out.name
            for video, out, label, crop in jobs
        }
        for i, fut in enumerate(as_completed(futures), 1):
            name = futures[fut]
            try:
                _, frames = fut.result()
                done += 1
                log(f"  [{i}/{len(jobs)}] extracted {name} ({frames} frames)")
            except Exception as ex:
                log(f"  [{i}/{len(jobs)}] {name} FAILED: {ex}")
    return done


def bulk_corpus(
    dest_dir: str | Path,
    workers: int = 4,
    delay: float = 2.0,
    limit: int = 0,
    deps: dict | None = None,
    log=print,
    sleep=time.sleep,
) -> dict:
    """All narrative (type-1) corpus units: fetch → download → extract → merge."""
    deps = deps or {}
    if not deps:
        from signavatar.corpus import download_video, fetch_unit, list_units

        deps = {
            "list_units": list_units,
            "fetch_unit": fetch_unit,
            "download_video": download_video,
        }
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    targets = [u["uuid"] for u in deps["list_units"]() if u.get("type") == "1"]
    if limit:
        targets = targets[:limit]

    # phase 1: unit details (needed for film_url + lexicon + pairs), throttled
    units = []
    for i, uuid in enumerate(targets, 1):
        try:
            units.append(deps["fetch_unit"](uuid))
        except Exception as ex:
            log(f"  {uuid}: detail fetch FAILED ({ex})")
            continue
        if i % 40 == 0:
            log(f"  details {i}/{len(targets)}")
        sleep(_jittered(min(delay, 0.5)))

    # phase 2: downloads, sequential + jittered delay (politeness)
    downloaded = 0
    for unit in units:
        video = dest / f"moc_{unit.uuid}.mp4"
        if video.is_file():
            continue
        try:
            deps["download_video"](unit, dest)
            downloaded += 1
        except Exception as ex:
            log(f"  {unit.uuid}: download FAILED ({ex})")
        sleep(_jittered(delay))

    # phase 3: extraction (parallel pool — the actual bottleneck)
    jobs = [
        (dest / f"moc_{u.uuid}.mp4", dest / f"moc_{u.uuid}.json", f"{u.theme} {u.name}")
        for u in units
        if (dest / f"moc_{u.uuid}.mp4").is_file() and not (dest / f"moc_{u.uuid}.json").is_file()
    ]
    log(f"downloads: {downloaded} new; extracting {len(jobs)} videos with {workers} workers")
    extracted = _run_extractions(jobs, workers, deps, log)

    # phase 4: merge lexicon/pairs/manifest for every unit with an extraction
    lex = load_lexicon(dest / "lexicon.json")
    pairs = load_pairs(dest / "tsl_pairs.json")
    added = 0
    for unit in units:
        out = dest / f"moc_{unit.uuid}.json"
        if not out.is_file():
            continue
        lex, n = merge_lexicon(lex, word_entries(unit, out.name))
        pairs = merge_pairs(pairs, sentence_pairs(unit))
        added += n
        _record_manifest(
            dest,
            "moc_manifest.json",
            unit.uuid,
            {
                "origin": f"https://tslcorpus.moc.gov.tw (文化部臺灣手語語料庫, uuid={unit.uuid})",
                "film_url": unit.film_url,
                "theme": unit.theme,
                "name": unit.name,
                "attr": unit.attr,
                "sentences": len(unit.sentences),
                "video_extracted": True,
            },
        )
    save_lexicon(lex, dest / "lexicon.json")
    save_pairs(pairs, dest / "tsl_pairs.json")
    log(f"lexicon: {len(lex)} entries (+{added}); pairs: {len(pairs)}")
    return {"downloaded": downloaded, "extracted": extracted, "lexicon": len(lex)}


# 對話單元把兩位演繹者左右並排合成在一格畫面裡(綠幕、中線接縫清楚),
# 逐句的 Speaker 標的就是畫面左右半邊。
_SPEAKER_CROP = {"L": (0.0, 0.5), "R": (0.5, 1.0)}


def bulk_dialogues(
    dest_dir: str | Path,
    workers: int = 4,
    delay: float = 2.0,
    limit: int = 0,
    deps: dict | None = None,
    log=print,
    sleep=time.sleep,
) -> dict:
    """對話單元(type=2):裁一半 → 單人管線 → 逐詞切詞條(resumable)。

    這批單元佔語料庫的一半,當初因為「雙人同框」整批跳過。實際上每句都帶
    Speaker(L/R)標記,把畫面裁成對應的半邊,後面的追蹤、切詞、詞條完全沿用
    敘事單元那條路;時間戳是時間軸上的,空間裁切不影響。
    """
    deps = deps or {}
    if not deps:
        from signavatar.corpus import download_video, fetch_unit, list_units

        deps = {
            "list_units": list_units,
            "fetch_unit": fetch_unit,
            "download_video": download_video,
        }
    dest = Path(dest_dir)
    dest.mkdir(parents=True, exist_ok=True)

    targets = [u["uuid"] for u in deps["list_units"]() if u.get("type") == "2"]
    if limit:
        targets = targets[:limit]

    units = []
    for i, uuid in enumerate(targets, 1):
        if (dest / f"moc_{uuid}.mp4").is_file() and all(
            (dest / f"moc_{uuid}_{s}.json").is_file() for s in _SPEAKER_CROP
        ):
            continue  # 已完成,連 detail 都不必再抓
        try:
            units.append(deps["fetch_unit"](uuid))
        except Exception as ex:
            log(f"  {uuid}: detail fetch FAILED ({ex})")
            continue
        if i % 40 == 0:
            log(f"  details {i}/{len(targets)}")
        sleep(_jittered(min(delay, 0.5)))

    downloaded = 0
    for unit in units:
        if (dest / f"moc_{unit.uuid}.mp4").is_file():
            continue
        try:
            deps["download_video"](unit, dest)
            downloaded += 1
        except Exception as ex:
            log(f"  {unit.uuid}: download FAILED ({ex})")
        sleep(_jittered(delay))

    jobs, plan = [], []
    for unit in units:
        video = dest / f"moc_{unit.uuid}.mp4"
        if not video.is_file():
            continue
        present = {s.speaker for s in unit.sentences if s.speaker in _SPEAKER_CROP}
        for speaker in sorted(present):
            out = dest / f"moc_{unit.uuid}_{speaker}.json"
            plan.append((unit, speaker, out))
            if not out.is_file():
                jobs.append(
                    (video, out, f"{unit.theme} {unit.name} {speaker}", _SPEAKER_CROP[speaker])
                )
    log(f"downloads: {downloaded} new; extracting {len(jobs)} half-frames with {workers} workers")
    extracted = _run_extractions(jobs, workers, deps, log)

    lex = load_lexicon(dest / "lexicon.json")
    added = 0
    seen: set[str] = set()
    for unit, speaker, out in plan:
        if not out.is_file():
            continue
        lex, n = merge_lexicon(lex, word_entries(unit, out.name, speaker=speaker))
        added += n
        if unit.uuid not in seen:
            seen.add(unit.uuid)
            _record_manifest(
                dest,
                "moc_manifest.json",
                unit.uuid,
                {
                    "origin": f"https://tslcorpus.moc.gov.tw (文化部臺灣手語語料庫, uuid={unit.uuid})",
                    "film_url": unit.film_url,
                    "theme": unit.theme,
                    "name": unit.name,
                    "attr": unit.attr,
                    "sentences": len(unit.sentences),
                    "video_extracted": True,
                    "dialogue_speakers": sorted(
                        {s.speaker for s in unit.sentences if s.speaker in _SPEAKER_CROP}
                    ),
                },
            )
    save_lexicon(lex, dest / "lexicon.json")
    log(f"lexicon: {len(lex)} entries (+{added} 對話)")
    return {"downloaded": downloaded, "extracted": extracted, "lexicon": len(lex)}


def rank_moe_words(moe_words: dict, lexicon: dict, pairs: list[dict]) -> list[str]:
    """Gap-fill priority: corpus-gloss frequency first, then common words —
    always excluding words the lexicon already covers."""
    from collections import Counter

    freq = Counter()
    for p in pairs:
        for g in p["glosses"]:
            freq[g] += 1
    candidates = [w for w in moe_words if w not in lexicon]
    return sorted(
        candidates,
        key=lambda w: (-freq.get(w, 0), not moe_words[w].get("is_common"), w),
    )


def _recording_duration(path: Path) -> float:
    frames = json.loads(path.read_text(encoding="utf-8")).get("frames", [])
    return round(frames[-1]["timestamp"], 3) if frames else 0.0


def bulk_moe(
    dest_dir: str | Path,
    words: list[str] | None = None,
    workers: int = 4,
    delay: float = 6.0,
    limit: int = 0,
    deps: dict | None = None,
    log=print,
    sleep=time.sleep,
) -> dict:
    """Gap-fill lexicon words from 教育部辭典 videos (YouTube — keep delay high)."""
    deps = deps or {}
    if "download_youtube" not in deps:
        from signavatar.moe_dict import download_youtube

        deps["download_youtube"] = download_youtube
    dest = Path(dest_dir)
    moe = json.loads((dest / "moe_dict.json").read_text(encoding="utf-8"))["words"]
    lex = load_lexicon(dest / "lexicon.json")
    if words is None:
        words = rank_moe_words(moe, lex, load_pairs(dest / "tsl_pairs.json"))
    if limit:
        words = words[:limit]

    def stem(entry):
        return "moe_" + entry["key"].removeprefix("vocabulary/").replace("/", "_")

    # downloads: sequential, long jittered delay (YouTube bans aggressive pulls)
    plan = []
    downloaded = 0
    for word in words:
        entry = moe.get(word)
        if not entry or word in lex:
            continue
        video = dest / f"{stem(entry)}.mp4"
        out = dest / f"{stem(entry)}.json"
        plan.append((word, entry, video, out))
        if video.is_file():
            continue
        try:
            deps["download_youtube"](entry["youtube_id"], video)
            downloaded += 1
        except Exception as ex:
            log(f"  {word}: download FAILED ({ex})")
        sleep(_jittered(delay))

    jobs = [
        (video, out, f"教育部 {word}")
        for word, entry, video, out in plan
        if video.is_file() and not out.is_file()
    ]
    log(f"downloads: {downloaded} new; extracting {len(jobs)} clips with {workers} workers")
    extracted = _run_extractions(jobs, workers, deps, log)

    added = 0
    for word, entry, _video, out in plan:
        if not out.is_file() or word in lex:
            continue
        lex[word] = {
            "recording": out.name,
            "start": 0.0,
            "end": _recording_duration(out),
            "gloss": word,
            "source": f"moe:{entry['key']}",
            "system": "文法手語",
        }
        added += 1
        _record_manifest(
            dest,
            "external_manifest.json",
            f"moe:{entry['key']}",
            {
                "origin": f"https://www.youtube.com/watch?v={entry['youtube_id']}",
                "word": word,
                "category": entry.get("category", ""),
                "license": "教育部開放宣告(資料)/YouTube 標準授權(影片);文法手語",
            },
        )
    save_lexicon(lex, dest / "lexicon.json")
    log(f"lexicon: {len(lex)} entries (+{added} 文法手語 gap-fill)")
    return {"downloaded": downloaded, "extracted": extracted, "lexicon": len(lex)}


_TASLI_LICENSE = (
    "社團法人臺灣手語翻譯協會 臺灣手語新詞數位學習網;已取得使用同意"
    "(使用者 2026-08-18 確認)。訓練資料不對外公開、不散布影片;引用須註明出處"
)


def bulk_tasli(
    dest_dir: str | Path,
    workers: int = 4,
    delay: float = 6.0,
    limit: int = 0,
    deps: dict | None = None,
    log=print,
    sleep=time.sleep,
) -> dict:
    """新詞網:下載詞彙影片 → 萃取 → 詞條(resumable)。

    影片在 YouTube,所以下載節流跟 bulk_moe 一樣保守。需要
    `recordings/tasli.json`(由 `signavatar tasli fetch` 產生)。
    """
    from signavatar.tasli import Entry, download_video, lexicon_keys

    deps = deps or {}
    dest = Path(dest_dir)
    data = json.loads((dest / "tasli.json").read_text(encoding="utf-8"))
    entries = [Entry.from_dict(e) for e in data["entries"]]
    if limit:
        entries = entries[:limit]

    downloaded, plan = 0, []
    for entry in entries:
        if not entry.word_video:
            log(f"  {entry.word}: 沒有詞彙影片(只有例句),跳過")
            continue
        video = dest / f"{entry.stem}.mp4"
        plan.append((entry, video, dest / f"{entry.stem}.json"))
        if video.is_file():
            continue
        try:
            deps.get("download_video", download_video)(entry, dest)
            downloaded += 1
        except Exception as ex:
            log(f"  {entry.word}: download FAILED ({ex})")
        sleep(_jittered(delay))

    jobs = [
        (video, out, f"新詞 {entry.word}")
        for entry, video, out in plan
        if video.is_file() and not out.is_file()
    ]
    log(f"downloads: {downloaded} new; extracting {len(jobs)} clips with {workers} workers")
    extracted = _run_extractions(jobs, workers, deps, log)

    lex = load_lexicon(dest / "lexicon.json")
    added = 0
    for entry, _video, out in plan:
        if not out.is_file():
            continue
        _record_manifest(
            dest,
            "external_manifest.json",
            f"tasli:{entry.wid}",
            {
                "origin": f"https://www.youtube.com/watch?v={entry.word_video}",
                "page": f"https://newtsl.taslifamily.org/新詞彙/{entry.wid}_{entry.word}",
                "word": entry.word,
                "videos": entry.videos,
                "license": _TASLI_LICENSE,
            },
        )
        end = _recording_duration(out)
        for key in lexicon_keys(entry.word):
            if key in lex:            # 只補缺詞,不覆蓋既有詞條
                continue
            lex[key] = {
                "recording": out.name,
                "start": 0.0,
                "end": end,
                "gloss": key,
                "source": f"tasli:{entry.wid}",
            }
            added += 1
    save_lexicon(lex, dest / "lexicon.json")
    log(f"lexicon: {len(lex)} entries (+{added} 新詞)")
    return {"downloaded": downloaded, "extracted": extracted, "lexicon": len(lex)}


_PLACENAME_LICENSE = (
    "張榮興台灣手語研究室版權所有;已取得使用同意(使用者 2026-08-17 確認)。"
    "訓練資料不對外公開、不散布影片與萃取結果;引用須註明出處"
)


def bulk_placenames(
    dest_dir: str | Path,
    workers: int = 4,
    delay: float = 1.5,
    limit: int = 0,
    deps: dict | None = None,
    log=print,
    sleep=time.sleep,
) -> dict:
    """台灣手語地名網 1000 個地名:download → extract → lexicon (resumable).

    Needs `recordings/placenames.json` from `signavatar placenames fetch`.
    Clips are small (~300 KB) and the host is a small research server, so
    downloads stay sequential and throttled like every other source here.
    """
    from signavatar.placenames import BASE_URL as PN_BASE_URL
    from signavatar.placenames import Place, download_video, lexicon_key

    deps = deps or {}
    dest = Path(dest_dir)
    data = json.loads((dest / "placenames.json").read_text(encoding="utf-8"))
    places = [Place.from_dict(p) for p in data["places"]]
    if limit:
        places = places[:limit]

    downloaded = 0
    for place in places:
        video = dest / f"{place.stem}.mp4"
        if video.is_file():
            continue
        try:
            deps.get("download_video", download_video)(place, dest)
            downloaded += 1
        except Exception as ex:
            log(f"  {place.name}: download FAILED ({ex})")
        sleep(_jittered(delay))

    jobs = [
        (dest / f"{p.stem}.mp4", dest / f"{p.stem}.json", f"地名 {p.name}")
        for p in places
        if (dest / f"{p.stem}.mp4").is_file() and not (dest / f"{p.stem}.json").is_file()
    ]
    log(f"downloads: {downloaded} new; extracting {len(jobs)} clips with {workers} workers")
    extracted = _run_extractions(jobs, workers, deps, log)

    lex = load_lexicon(dest / "lexicon.json")
    added = 0
    for place in places:
        out = dest / f"{place.stem}.json"
        if not out.is_file():
            continue
        _record_manifest(
            dest,
            "external_manifest.json",
            f"placename:{place.serno}",
            {
                "origin": place.video_url,
                "page": f"{PN_BASE_URL}areavideo.php?serno={place.serno}",
                "word": place.name,
                "county": place.county,
                "morphemes": place.morphemes,
                "license": _PLACENAME_LICENSE,
            },
        )
        key = lexicon_key(place.name)
        if key in lex:  # 自然手語/既有詞條優先,地名只補缺
            continue
        lex[key] = {
            "recording": out.name,
            "start": 0.0,
            "end": _recording_duration(out),
            "gloss": key,
            "source": f"placename:{place.serno}",
            "text": place.description,
            "county": place.county,
        }
        added += 1
    save_lexicon(lex, dest / "lexicon.json")
    log(f"lexicon: {len(lex)} entries (+{added} 地名)")
    return {"downloaded": downloaded, "extracted": extracted, "lexicon": len(lex)}
