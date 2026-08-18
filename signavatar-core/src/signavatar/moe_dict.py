"""教育部常用手語辭典 (special.moe.gov.tw/signlanguage) API client.

Open unauthenticated JSON API (14 vocabulary categories, ~15,770 entries,
each with a YouTube video key). Word metadata is reusable under the site's
政府網站資料開放宣告 (attribution required). NOTE: this dictionary skews
文法手語 (signed Mandarin) — entries ingested into the lexicon must carry
`system: 文法手語` so they stay distinguishable from natural-TSL entries.

Network entry points take an injectable transport; tests never hit the API.
"""

from __future__ import annotations

import json
import shutil
import subprocess
import urllib.request
from collections.abc import Callable
from urllib.parse import quote

BASE_URL = "https://special.moe.gov.tw"
_TIMEOUT_S = 60


def _get_json(path: str) -> list:
    with urllib.request.urlopen(BASE_URL + path, timeout=_TIMEOUT_S) as res:
        return json.loads(res.read())


def fetch_categories(fetch: Callable[[str], list] = _get_json) -> list[dict]:
    return fetch("/signlanguage/api/contentTypes?type=vocabulary")


def fetch_entries(category_key: str, fetch: Callable[[str], list] = _get_json) -> list[dict]:
    """Entries of one category; entries without a video are skipped and the
    youtubeKey embed suffix (?rel=0) is stripped to a bare video id."""
    raw = fetch(f"/signlanguage/api/contentTypes?type={quote(category_key, safe='')}")
    entries = []
    for e in raw:
        key = e.get("youtubeKey")
        if not key:
            continue
        entries.append(
            {
                "key": e["key"],
                "word": e["title"],
                "description": e.get("description") or "",
                "youtube_id": key.split("?")[0],
                "is_common": bool(e.get("isCommon")),
                "is_advance": bool(e.get("isAdvance")),
            }
        )
    return entries


def download_youtube(url_or_id: str, dest):
    """Download a YouTube video via yt-dlp (installed as a uv tool)."""
    if dest.is_file():
        return dest
    exe = shutil.which("yt-dlp")
    if not exe:
        raise RuntimeError("yt-dlp not found — install with `uv tool install yt-dlp`")
    url = (
        url_or_id
        if url_or_id.startswith("http")
        else f"https://www.youtube.com/watch?v={url_or_id}"
    )
    # player_client=android:機器上沒有 JS runtime 時,預設的 client 會拿到需要
    # 簽章的媒體網址,約四分之一的下載間歇性 403。實測 android client 不需要
    # 簽章、同一批影片 4/4 成功。(裝 deno 之類的 JS runtime 也能解,但那是
    # 環境層的事,這裡先用不必額外安裝的路。)
    result = subprocess.run(
        [exe, "--extractor-args", "youtube:player_client=android",
         "-f", "mp4[height<=720]/best[height<=720]/best", "-o", str(dest), url],
        capture_output=True,
        text=True,
        timeout=600,
    )
    if result.returncode != 0:
        # yt-dlp 把真正的原因寫在 stderr,不帶出來的話上層只看得到 returncode
        tail = (result.stderr or result.stdout or "").strip().splitlines()
        raise RuntimeError(f"yt-dlp failed ({result.returncode}): {tail[-1] if tail else '?'}")
    return dest


def fetch_all_words(fetch: Callable[[str], list] = _get_json) -> dict[str, dict]:
    """word → entry across all categories; on duplicates a common (常用)
    entry replaces a non-common one, otherwise first wins."""
    words: dict[str, dict] = {}
    for cat in fetch_categories(fetch=fetch):
        for entry in fetch_entries(cat["key"], fetch=fetch):
            entry["category"] = cat["title"]
            existing = words.get(entry["word"])
            if existing is None or (entry["is_common"] and not existing["is_common"]):
                words[entry["word"]] = entry
    return words
