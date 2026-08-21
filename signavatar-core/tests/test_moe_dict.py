"""教育部常用手語辭典 API client (injected transport, no network)."""

from signavatar.moe_dict import fetch_all_words, fetch_categories, fetch_entries

CATEGORIES = [
    {"key": "vocabulary/01", "title": "數字、日期", "description": "時間、年、月、週、日"},
    {"key": "vocabulary/02", "title": "生活用語", "description": ""},
]

ENTRIES_01 = [
    {
        "key": "vocabulary/01/0001",
        "title": "一兆",
        "description": "a million million",
        "isCommon": False,
        "isAdvance": True,
        "youtubeKey": "xwMfBmrP8WE?rel=0",
    },
    {
        "key": "vocabulary/01/0002",
        "title": "今天",
        "description": "today",
        "isCommon": True,
        "isAdvance": False,
        "youtubeKey": "abcDEF12345",
    },
    {
        "key": "vocabulary/01/0003",
        "title": "無影片",
        "description": "",
        "isCommon": True,
        "isAdvance": False,
        "youtubeKey": None,
    },
]


def _fake_fetch(path):
    if path.endswith("type=vocabulary"):
        return CATEGORIES
    if "vocabulary%2F01" in path:
        return ENTRIES_01
    return []


def test_fetch_categories():
    cats = fetch_categories(fetch=_fake_fetch)
    assert cats[0]["key"] == "vocabulary/01"


def test_fetch_entries_strips_youtube_suffix_and_skips_no_video():
    entries = fetch_entries("vocabulary/01", fetch=_fake_fetch)
    assert len(entries) == 2  # 無影片 skipped
    assert entries[0]["youtube_id"] == "xwMfBmrP8WE"
    assert entries[0]["word"] == "一兆"
    assert entries[1]["is_common"] is True


def test_fetch_all_words_maps_word_to_entry():
    words = fetch_all_words(fetch=_fake_fetch)
    assert words["今天"]["youtube_id"] == "abcDEF12345"
    assert words["今天"]["category"] == "數字、日期"
    assert words["一兆"]["key"] == "vocabulary/01/0001"


def test_fetch_all_words_prefers_common_on_duplicate():
    def dup_fetch(path):
        if path.endswith("type=vocabulary"):
            return CATEGORIES
        if "vocabulary%2F01" in path:
            return [ENTRIES_01[0]]
        if "vocabulary%2F02" in path:
            return [dict(ENTRIES_01[0], key="vocabulary/02/0009", isCommon=True)]
        return []

    words = fetch_all_words(fetch=dup_fetch)
    assert words["一兆"]["key"] == "vocabulary/02/0009"  # isCommon wins


def test_download_youtube_uses_a_client_that_needs_no_js_runtime(monkeypatch, tmp_path):
    """沒有 JS runtime 時預設 client 會間歇 403,必須指定 android client。"""
    import subprocess

    from signavatar import moe_dict

    seen = {}

    def fake_run(cmd, **kw):
        seen["cmd"] = cmd
        return subprocess.CompletedProcess(cmd, 0, "", "")

    monkeypatch.setattr(moe_dict.shutil, "which", lambda n: "/usr/bin/yt-dlp", raising=False)
    monkeypatch.setattr(subprocess, "run", fake_run)
    moe_dict.download_youtube("abc12345678", tmp_path / "v.mp4")
    assert "youtube:player_client=android" in seen["cmd"]


def test_download_youtube_surfaces_the_real_error(monkeypatch, tmp_path):
    import subprocess

    from signavatar import moe_dict

    monkeypatch.setattr(moe_dict.shutil, "which", lambda n: "/usr/bin/yt-dlp", raising=False)
    monkeypatch.setattr(
        subprocess, "run",
        lambda cmd, **kw: subprocess.CompletedProcess(cmd, 1, "", "ERROR: HTTP Error 403: Forbidden"))
    try:
        moe_dict.download_youtube("abc12345678", tmp_path / "v.mp4")
    except RuntimeError as ex:
        assert "403" in str(ex)      # returncode 之外要看得到原因
    else:
        raise AssertionError("should have raised")
