"""台灣手語姓氏網 scraper（injected transport, no network）。

與地名站共用同一套 Dreamweaver 樣板，差異都在 fixture 裡留著：
CSS class 是 style71 不是 style7、serno 才是主鍵、影片前綴是 f_ 不是 p_。
"""

import json

from signavatar.bulk import bulk_familynames
from signavatar.familynames import Surname, fetch_all, fetch_index, fetch_surname

INDEX = """
<a href="namevideo.php?searchtp=10&&countno=2&&firstname=%E5%88%81&&serno=1">刁</a>
<a href="namevideo.php?searchtp=10&&countno=8&&firstname=%E6%9E%97&&serno=2">林</a>
<a href="namevideo.php?searchtp=10&&countno=8&&firstname=%E6%9E%97&&serno=2">林</a>
"""
DETAIL = """
<video><source src="./admin/upload/f_001.mp4" type="video/mp4" /></video>
<br />刁 <table width="580">
  <tr><td bgcolor="#D3D3D3"><span class="style71">「刁」</span></td><td bgcolor="#D3D3D3"></td></tr>
  <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style71">表達方式</span></div></td>
  <td bgcolor="#C8DFFB"><span class="style71">取字形</span></td></tr>
  <tr><td width="18%" bgcolor="#FFCCFF"><div align="center"><span class="style71">打法描述</span></div></td>
  <td bgcolor="#C8DFFB"><span class="style71">左/六/在前，右/一/斜劃。</span></td></tr>
</table>
"""


def _fetch(url):
    return DETAIL if "namevideo.php" in url else INDEX


def test_fetch_index_reads_name_and_stroke_and_dedupes():
    assert fetch_index(fetch=_fetch) == {1: ("刁", 2), 2: ("林", 8)}


def test_fetch_surname_parses_the_style71_morpheme_table():
    s = fetch_surname(1, "刁", 2, fetch=_fetch)
    assert s.video_url == "https://jung-hsingchang.tw/name/admin/upload/f_001.mp4"
    assert s.stem == "fn_0001_刁"
    assert s.morphemes == [{"字素": "刁", "表達方式": "取字形",
                            "打法描述": "左/六/在前，右/一/斜劃。"}]
    assert s.description == "左/六/在前，右/一/斜劃。"


def test_lexicon_keys_follow_the_existing_surname_convention():
    # 詞庫既有的姓氏詞條寫成「丁(姓)」，沿用它；裸字另給一個鍵
    assert Surname(2, "林").lexicon_keys() == ["林(姓)", "林"]


def test_fetch_all_covers_every_indexed_surname():
    assert {s.name for s in fetch_all(fetch=_fetch, log=None)} == {"刁", "林"}


def test_surname_roundtrips_through_dict():
    s = fetch_surname(1, "刁", 2, fetch=_fetch)
    assert Surname.from_dict(s.to_dict()) == s


def _fake_extract(video_path, out_path, **kw):
    from signavatar.schema import Frame, Recording, save_recording

    rec = Recording(fps=25.0, source_width=720, source_height=480,
                    created_at="2026-08-18T00:00:00+00:00",
                    frames=[Frame(index=0, timestamp=0.0, hands=[]),
                            Frame(index=1, timestamp=3.2, hands=[])],
                    label=kw.get("label", ""))
    save_recording(rec, out_path)
    return rec


def _write(tmp_path, rows):
    (tmp_path / "familynames.json").write_text(
        json.dumps({"origin": "x", "surnames": rows}, ensure_ascii=False), encoding="utf-8")


def test_bulk_familynames_adds_both_keys(tmp_path):
    _write(tmp_path, [{"serno": 1, "name": "刁", "stroke": 2,
                       "video_url": "https://x/f_001.mp4",
                       "morphemes": [{"字素": "刁", "打法描述": "左/六/在前。"}]}])
    deps = {"download_video": lambda s, d, **k: (tmp_path / f"{s.stem}.mp4").write_bytes(b"MP4"),
            "extract": _fake_extract}
    stats = bulk_familynames(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    assert stats["extracted"] == 1
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["刁(姓)"]["source"] == "familyname:1"
    assert lex["刁"]["recording"] == lex["刁(姓)"]["recording"]
    assert lex["刁"]["end"] == 3.2 and lex["刁"]["stroke"] == 2
    man = json.loads((tmp_path / "external_manifest.json").read_text(encoding="utf-8"))
    assert man["familyname:1"]["word"] == "刁"


def test_bulk_familynames_keeps_the_ordinary_word_sign(tmp_path):
    """山、水、方 這些姓氏字在詞庫裡多半已是一般詞（山＝山，不是姓）。
    裸字鍵要保留既有的，姓氏版走 X(姓)。"""
    (tmp_path / "lexicon.json").write_text(
        json.dumps({"山": {"recording": "moc_G1.json", "start": 0, "end": 1,
                           "source": "moc:G1"}}, ensure_ascii=False), encoding="utf-8")
    _write(tmp_path, [{"serno": 3, "name": "山", "stroke": 3,
                       "video_url": "https://x/f_003.mp4", "morphemes": []}])
    deps = {"download_video": lambda s, d, **k: (tmp_path / f"{s.stem}.mp4").write_bytes(b"MP4"),
            "extract": _fake_extract}
    bulk_familynames(tmp_path, workers=0, delay=0, deps=deps, sleep=lambda s: None)
    lex = json.loads((tmp_path / "lexicon.json").read_text(encoding="utf-8"))
    assert lex["山"]["source"] == "moc:G1"          # 一般詞保留
    assert lex["山(姓)"]["source"] == "familyname:3"  # 姓氏版仍收得到
