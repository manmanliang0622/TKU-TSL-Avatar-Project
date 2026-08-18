"""台灣手語地名網 scraper (injected transport, no network).

Fixtures keep the site's real markup quirks: unclosed <td>, the nav bar
repeating areavideo links outside the result menu, and detail pages that
omit 表達方式/造詞策略 for single-morpheme places.
"""

import json

from signavatar.bulk import bulk_placenames
from signavatar.placenames import (
    Place,
    fetch_county,
    fetch_index,
    fetch_place,
    lexicon_key,
    parse_morphemes,
    safe_name,
)

COUNTY_HTML = """
<a href="placenames_database.php?searchtp=0&&localname=1">基隆</a>
<td>right_menu">
  <tr><td><span class="style6">基隆</span></td>
  <td><a href="areavideo.php?serno=5&&areaname=&&maxrows=0&&searchtp=0&&localname=1#5">七堵</a></td></tr>
  <tr><td><span class="style6">基隆</span></td>
  <td><a href="areavideo.php?serno=24&&areaname=&&maxrows=0&&searchtp=0&&localname=1#24">八堵</a></td></tr>
</td>
<div id="right_advertisement">
  <a href="areavideo.php?serno=999&&localname=1">廣告區不該被收</a>
</div>
"""

DETAIL_HTML = """
<video controls autoplay = "autoplay" width="640" height="360">
  <source src="./admin/upload/p_005.mp4" type="video/mp4" />
  <source src="http://clips.example/big_buck_bunny.webm" type="video/webm" />
</video>
<tr>
  <td colspan="5">
  七堵<br>
  <table width="580">
    <tr><td bgcolor="#D3D3D3"><span class="style7">「七」</span></td><td bgcolor="#D3D3D3"></td></tr>
    <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style7">表達方式</span></div></td>
    <td bgcolor="#C8DFFB"><span class="style7">取字義</span></td></tr>
    <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style7">造詞策略</span></div></td>
    <td bgcolor="#C8DFFB"><span class="style7">全字直譯</span></td></tr>
    <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style7">運用手形</span></div></td>
    <td bgcolor="#C8DFFB"><span class="style7">七(右)</span></td></tr>
    <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style7">打法描述</span></div></td>
    <td bgcolor="#C8DFFB"><span class="style7">右/七/橫放，掌心朝內。</span></td></tr>
    <tr><td bgcolor="#D3D3D3"><span class="style7">「堵(豬)」</span></td><td bgcolor="#D3D3D3"></td></tr>
    <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style7">運用手形</span></div></td>
    <td bgcolor="#C8DFFB"><span class="style7">民(右)</span></td></tr>
    <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style7">打法描述</span></div></td>
    <td bgcolor="#C8DFFB"><span class="style7">右/民/掌心朝內，放在鼻子處。</span></td></tr>
  </table>
</tr>
"""


def _fake_fetch(url):
    return DETAIL_HTML if "areavideo.php" in url else COUNTY_HTML


def test_fetch_county_ignores_nav_and_advertisement_links():
    rows = fetch_county(1, fetch=_fake_fetch)
    assert rows == [(5, "七堵"), (24, "八堵")]


def test_fetch_index_covers_every_county_first_wins():
    index = fetch_index(fetch=_fake_fetch)
    assert index == {5: "台北", 24: "台北"}  # localname=0 (台北) is crawled first


def test_fetch_place_reads_title_video_and_morphemes():
    place = fetch_place(5, "基隆", fetch=_fake_fetch)
    assert place.name == "七堵"
    assert place.video_url == "https://jung-hsingchang.tw/name/admin/upload/p_005.mp4"
    assert place.stem == "pn_0005_七堵"
    assert [m["字素"] for m in place.morphemes] == ["七", "堵(豬)"]
    assert place.morphemes[0]["造詞策略"] == "全字直譯"
    # single-morpheme pages omit 表達方式/造詞策略 — absent, not empty
    assert "造詞策略" not in place.morphemes[1]
    assert place.description == "右/七/橫放，掌心朝內。 右/民/掌心朝內，放在鼻子處。"


def test_parse_morphemes_on_page_without_analysis_table():
    assert parse_morphemes("<html>no table</html>") == []


def test_place_roundtrips_through_dict():
    place = fetch_place(5, "基隆", fetch=_fake_fetch)
    assert Place.from_dict(place.to_dict()) == place


def test_safe_name_and_lexicon_key():
    assert safe_name("中山/北路") == "中山_北路"
    assert safe_name("那個人是誰?") == "那個人是誰"  # trailing separator trimmed
    assert lexicon_key("基隆2") == "基隆"  # 同地名的第二種打法
    assert lexicon_key("七堵") == "七堵"
    assert lexicon_key("101") == "101"  # all-digit name must not vanish


def _fake_extract(video_path, out_path, **kwargs):
    from signavatar.schema import Frame, Recording, save_recording

    rec = Recording(
        fps=30.0,
        source_width=640,
        source_height=480,
        created_at="2026-08-17T00:00:00+00:00",
        frames=[Frame(index=0, timestamp=0.0, hands=[]), Frame(index=1, timestamp=1.5, hands=[])],
        label=kwargs.get("label", ""),
    )
    save_recording(rec, out_path)
    return rec


def _write_placenames_json(tmp_path, places):
    (tmp_path / "placenames.json").write_text(
        json.dumps({"origin": "x", "places": places}, ensure_ascii=False), encoding="utf-8"
    )


def test_bulk_placenames_end_to_end_and_resume(tmp_path):
    downloads = []
    _write_placenames_json(
        tmp_path,
        [
            {
                "serno": 5,
                "name": "七堵",
                "county": "基隆",
                "video_url": "https://x/p_005.mp4",
                "morphemes": [{"字素": "七", "打法描述": "右/七/橫放。"}],
            },
            {
                "serno": 639,
                "name": "基隆1",
                "county": "基隆",
                "video_url": "https://x/p_639.mp4",
                "morphemes": [],
            },
            {
                "serno": 640,
                "name": "基隆2",
                "county": "基隆",
                "video_url": "https://x/p_640.mp4",
                "morphemes": [],
            },
        ],
    )

    def fake_download(place, dest_dir, **kwargs):
        dest = tmp_path / f"{place.stem}.mp4"
        dest.write_bytes(b"MP4")
        downloads.append(place.serno)
        return dest

    deps = {"download_video": fake_download, "extract": _fake_extract}
    stats = bulk_placenames(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats["downloaded"] == 3
    assert stats["extracted"] == 3

    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["七堵"]["recording"] == "pn_0005_七堵.json"
    assert lex["七堵"]["source"] == "placename:5"
    assert lex["七堵"]["end"] == 1.5  # duration read back from the recording
    assert lex["七堵"]["text"] == "右/七/橫放。"
    # 基隆1/基隆2 are two signs for one place: one lexicon key, first wins
    assert lex["基隆"]["recording"] == "pn_0639_基隆1.json"
    assert "基隆1" not in lex

    manifest = json.loads((tmp_path / "external_manifest.json").read_text(encoding="utf-8"))
    assert "訓練資料不對外公開" in manifest["placename:5"]["license"]
    assert manifest["placename:640"]["word"] == "基隆2"  # variants still logged

    stats2 = bulk_placenames(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert (stats2["downloaded"], stats2["extracted"]) == (0, 0)
    assert downloads == [5, 639, 640]


def test_bulk_placenames_never_clobbers_an_existing_entry(tmp_path):
    (tmp_path / "lexicon.json").write_text(
        json.dumps({"七堵": {"recording": "moc_G1.json", "start": 1.0, "end": 2.0,
                             "source": "moc:G1"}}, ensure_ascii=False),
        encoding="utf-8",
    )
    _write_placenames_json(
        tmp_path,
        [{"serno": 5, "name": "七堵", "county": "基隆", "video_url": "https://x/p_005.mp4",
          "morphemes": []}],
    )
    deps = {
        "download_video": lambda p, d, **k: (tmp_path / f"{p.stem}.mp4").write_bytes(b"MP4"),
        "extract": _fake_extract,
    }
    bulk_placenames(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["七堵"]["source"] == "moc:G1"  # 自然手語詞條保留
