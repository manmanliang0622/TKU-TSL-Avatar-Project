"""新詞網 scraper（injected transport, no network）。

Fixtures 保留站上的真實特徵：Google Sites 的導覽列每頁只展開當前區塊，
所以枚舉一定要掃多個索引頁取聯集；iframe 的 aria-label 是分辨
「手語詞彙」與「手語句子」的唯一依據。
"""

import json

from signavatar.bulk import bulk_tasli
from signavatar.tasli import Entry, fetch_all, fetch_entry, fetch_index, lexicon_keys, safe_name

SECTIONS = """
 <a href="/年度檢索/2025詞彙手語">2025</a><a href="/主題探索/醫療衛生">醫療</a>
 <a href="/新詞彙/00452_葉克膜">葉克膜</a>
"""
# 主題頁多展開了一個詞——這正是要掃多頁的理由
TOPIC = """
 <a href="/新詞彙/00452_葉克膜">葉克膜</a><a href="/新詞彙/00001_優步uber">優步</a>
"""
YEAR = ' <a href="/新詞彙/00452_葉克膜">葉克膜</a>'

DETAIL = """
<script>{"pageTitle":"00452_葉克膜"}</script>
<iframe aria-label="YouTube Video, 葉克膜 手語詞彙" src="https://www.youtube.com/embed/GcUCXMJ9IxY?x=1"></iframe>
<iframe aria-label="YouTube Video, 葉克膜 手語句子" src="https://www.youtube.com/embed/PN4tR5IDs6g?x=1"></iframe>
"""
DETAIL_UBER = """
<script>{"pageTitle":"00001_優步（Uber）"}</script>
<iframe aria-label="YouTube Video, 優步（Uber） 手語詞彙" src="https://www.youtube.com/embed/UQYIPSYGKCY?x=1"></iframe>
"""


def _fetch(path):
    if path == "/年度檢索":
        return SECTIONS
    if path.startswith("/主題探索"):
        return TOPIC
    if path.startswith("/年度檢索/"):
        return YEAR
    if path.startswith("/新詞彙/00001"):
        return DETAIL_UBER
    return DETAIL


def test_fetch_index_unions_every_section_page():
    # 年度頁只看得到 1 個詞，主題頁多 1 個 —— 聯集才完整
    assert fetch_index(fetch=_fetch, log=None) == {"00452": "葉克膜", "00001": "優步uber"}


def test_fetch_entry_reads_canonical_word_and_labels_videos():
    e = fetch_entry("00452", "葉克膜", fetch=_fetch)
    assert e.word == "葉克膜"
    assert e.videos == {"手語詞彙": "GcUCXMJ9IxY", "手語句子": "PN4tR5IDs6g"}
    assert e.word_video == "GcUCXMJ9IxY"      # 例句那支不能拿來當詞條
    assert e.stem == "tasli_00452_葉克膜"


def test_fetch_entry_prefers_the_page_title_over_the_url_form():
    # URL 是 00001_優步uber，正式詞形是 優步（Uber）
    assert fetch_entry("00001", "優步uber", fetch=_fetch).word == "優步（Uber）"


def test_fetch_all_returns_every_indexed_word():
    words = {e.word for e in fetch_all(fetch=_fetch, log=None)}
    assert words == {"葉克膜", "優步（Uber）"}


def test_word_video_survives_every_label_variant_the_site_uses():
    # 實測站上跨年份的五種詞彙標籤 + 早期批次「拿詞名當標籤、例句標 B##(例句)」
    variants = [
        {"手語詞彙": "w", "手語句子": "s"},
        {"- 詞彙": "w", "- 句子": "s"},
        {"詞彙": "w", "句子": "s"},
        {"- 詞𢑥": "w", "- 句子": "s"},          # 罕見異體字
        {"手語辭彙": "w", "手語句子": "s"},        # 辭彙不是詞彙
        {"Uber": "w", "B16 Uber(例句)": "s"},
        {"B19(例句)": "s", "空拍": "w"},          # 例句排在前面
    ]
    for videos in variants:
        assert Entry("00001", "x", videos).word_video == "w", videos


def test_word_video_is_none_when_only_the_example_exists():
    assert Entry("00009", "x", {"手語句子": "s"}).word_video is None
    assert Entry("00010", "x", {}).word_video is None


def test_lexicon_keys_splits_the_parenthetical_alias():
    assert lexicon_keys("優步（Uber）") == ["優步", "Uber"]
    assert lexicon_keys("阿茲海默症（失智症）") == ["阿茲海默症", "失智症"]
    assert lexicon_keys("葉克膜") == ["葉克膜"]


def test_safe_name_handles_slashes():
    assert safe_name("禁藥/毒品") == "禁藥_毒品"


def _fake_extract(video_path, out_path, **kwargs):
    from signavatar.schema import Frame, Recording, save_recording

    rec = Recording(fps=30.0, source_width=640, source_height=360,
                    created_at="2026-08-18T00:00:00+00:00",
                    frames=[Frame(index=0, timestamp=0.0, hands=[]),
                            Frame(index=1, timestamp=2.5, hands=[])],
                    label=kwargs.get("label", ""))
    save_recording(rec, out_path)
    return rec


def _write_tasli(tmp_path, entries):
    (tmp_path / "tasli.json").write_text(
        json.dumps({"origin": "x", "entries": entries}, ensure_ascii=False), encoding="utf-8")


def test_bulk_tasli_adds_both_names_of_a_parenthetical_word(tmp_path):
    _write_tasli(tmp_path, [{"wid": "00001", "word": "優步（Uber）",
                             "videos": {"手語詞彙": "vid1", "手語句子": "vid2"}}])

    def fake_dl(entry, dest_dir, **kw):
        p = tmp_path / f"{entry.stem}.mp4"
        p.write_bytes(b"MP4")
        return p

    deps = {"download_video": fake_dl, "extract": _fake_extract}
    stats = bulk_tasli(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats["extracted"] == 1
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["優步"]["source"] == "tasli:00001"
    assert lex["Uber"]["recording"] == lex["優步"]["recording"]   # 同一支影片
    assert lex["優步"]["end"] == 2.5
    man = json.loads((tmp_path / "external_manifest.json").read_text(encoding="utf-8"))
    assert man["tasli:00001"]["origin"].endswith("vid1")          # 詞彙影片，不是例句
    assert "訓練資料不對外公開" in man["tasli:00001"]["license"]


def test_bulk_tasli_skips_entries_without_a_word_video(tmp_path):
    _write_tasli(tmp_path, [{"wid": "00009", "word": "只有例句",
                             "videos": {"手語句子": "vid2"}}])
    deps = {"download_video": lambda *a, **k: None, "extract": _fake_extract}
    stats = bulk_tasli(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats == {"downloaded": 0, "extracted": 0, "lexicon": 0}


def test_bulk_tasli_throttles_after_a_failed_download(tmp_path):
    """下載失敗也要等 —— 失敗時直接跳到下一個會加速撞 YouTube，
    把偶發失敗滾成連鎖失敗（實測 471 個詞裡失敗 26 個就是這樣來的）。"""
    _write_tasli(tmp_path, [
        {"wid": f"{i:05d}", "word": f"詞{i}", "videos": {"手語詞彙": f"v{i}"}} for i in range(1, 4)
    ])
    slept = []

    def boom(entry, dest_dir, **kw):
        raise RuntimeError("HTTP 429")

    bulk_tasli(tmp_path, workers=0, delay=6, deps={"download_video": boom, "extract": _fake_extract},
               sleep=slept.append, log=lambda *a: None)
    assert len(slept) == 3 and all(s > 0 for s in slept)


def test_bulk_tasli_never_clobbers_an_existing_entry(tmp_path):
    (tmp_path / "lexicon.json").write_text(
        json.dumps({"優步": {"recording": "moc_G1.json", "start": 0, "end": 1,
                            "source": "moc:G1"}}, ensure_ascii=False), encoding="utf-8")
    _write_tasli(tmp_path, [{"wid": "00001", "word": "優步（Uber）",
                             "videos": {"手語詞彙": "vid1"}}])
    deps = {
        "download_video": lambda e, d, **k: (tmp_path / f"{e.stem}.mp4").write_bytes(b"MP4"),
        "extract": _fake_extract,
    }
    bulk_tasli(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["優步"]["source"] == "moc:G1"     # 自然手語詞條保留
    assert lex["Uber"]["source"] == "tasli:00001"  # 沒被占用的別名還是補得上
