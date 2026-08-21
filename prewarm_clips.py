#!/usr/bin/env python3
"""Pre-cut every lexicon entry into clip_cache/ so no request ever waits on a parse.

The server cuts clips on demand and caches them, so this is an optimisation,
not a requirement: it just moves the one-off cost of reading a 10-80 MB
recording off the first user who asks for that word.

Recordings are processed largest first, because those are the entries where
the wait is worst. Already-cached clips are skipped, so this is resumable —
stop it with Ctrl-C and run it again whenever.

    .venv/bin/python3 prewarm_clips.py            # everything
    .venv/bin/python3 prewarm_clips.py --limit 50 # the 50 biggest recordings
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import bundle_server as srv


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--limit", type=int, default=0, help="only the N largest recordings")
    parser.add_argument("--lexicon", default="recordings/lexicon.json")
    arguments = parser.parse_args()

    lexicon_path = srv.ROOT / arguments.lexicon
    lexicon = json.loads(lexicon_path.read_text(encoding="utf-8"))

    by_recording: dict[str, list[tuple[float, float]]] = {}
    for entry in lexicon.values():
        name = entry.get("recording")
        start = entry.get("start")
        end = entry.get("end")
        if not isinstance(name, str) or not isinstance(start, (int, float)):
            continue
        if not isinstance(end, (int, float)) or end < start:
            continue
        by_recording.setdefault(name, []).append((float(start), float(end)))

    def size_of(name: str) -> int:
        path = srv.recording_path(name)
        try:
            return path.stat().st_size if path else 0
        except OSError:
            return 0

    order = sorted(by_recording, key=size_of, reverse=True)
    if arguments.limit > 0:
        order = order[: arguments.limit]

    total_clips = sum(len(by_recording[name]) for name in order)
    done = cut = skipped = missing = 0
    started = time.time()
    for position, name in enumerate(order, 1):
        ranges = by_recording[name]
        outstanding = [
            (start, end)
            for start, end in ranges
            if not srv.clip_cache_path(name, start, end).is_file()
        ]
        skipped += len(ranges) - len(outstanding)
        done += len(ranges) - len(outstanding)
        if not outstanding:
            continue
        if srv.recording_path(name) is None:
            missing += len(outstanding)
            done += len(outstanding)
            continue
        srv.build_clips([(name, start, end) for start, end in outstanding])
        cut += len(outstanding)
        done += len(outstanding)
        elapsed = time.time() - started
        rate = done / elapsed if elapsed else 0
        print(
            f"[{position}/{len(order)}] {name} +{len(outstanding)} clips "
            f"({done}/{total_clips}, {rate:.0f}/s)",
            flush=True,
        )

    size = sum(
        path.stat().st_size for path in srv.CLIP_CACHE.rglob("*.json.gz")
    ) if srv.CLIP_CACHE.is_dir() else 0
    print(
        f"done: {cut} cut, {skipped} already cached, {missing} without a recording; "
        f"cache {size / 1e6:.0f} MB in {time.time() - started:.0f}s",
        flush=True,
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
