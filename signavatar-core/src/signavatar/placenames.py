"""台灣手語地名網 (jung-hsingchang.tw/name) scraper.

張榮興台灣手語研究室的地名資料庫:1000 個台灣地名,每個地名一支手語影片,
外加逐字素的構詞分析(表達方式/造詞策略/運用手形/打法描述)。頁面是 2010 年的
靜態 PHP + Dreamweaver 巢狀表格,沒有 API;標籤大量未閉合,HTML parser 反而
比 regex 難維護,所以這裡直接對固定的樣板做 regex 擷取。

授權:站上沒有開放宣告(頁尾只有「張榮興台灣手語研究室版權所有」),
已另行取得研究室使用同意。**同意的是使用,不是公開**——訓練資料不對外
公開、影片與萃取結果不散布。入庫的每一筆都在 external_manifest.json
記下 origin 與這個授權條件。

Network entry points take an injectable transport; tests never hit the site.
"""

from __future__ import annotations

import re
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

BASE_URL = "https://jung-hsingchang.tw/name/"
_TIMEOUT_S = 60
_UA = "Mozilla/5.0 (signavatar research crawler)"

# 站上導覽列/地圖的 localname 參數 → 縣市名
COUNTIES: dict[int, str] = {
    0: "台北", 1: "基隆", 2: "桃園", 3: "新竹", 4: "苗栗", 5: "台中", 6: "南投",
    7: "彰化", 8: "雲林", 9: "嘉義", 10: "台南", 11: "高雄", 12: "屏東",
    13: "台東", 14: "花蓮", 15: "宜蘭", 16: "澎湖", 17: "金門", 18: "馬祖",
}

_LINK_RE = re.compile(r'areavideo\.php\?serno=(\d+)[^"]*"[^>]*>([^<]+)</a>')
_VIDEO_RE = re.compile(r'<source\s+src="([^"]+\.mp4)"')
_TITLE_RE = re.compile(r'<td colspan="5">\s*([^<>]+?)\s*<br\s*/?>')
# 構詞分析表:每個字素一個灰底表頭「X」,底下每種欄位各一列
_MORPH_HEAD_RE = re.compile(r'bgcolor="#D3D3D3"><span class="style7">「(.*?)」</span>', re.S)
_FIELD_RE = re.compile(
    r'<span class="style7">(表達方式|造詞策略|運用手形|打法描述)</span></div></td>\s*'
    r'<td[^>]*><span class="style7">(.*?)</span>',
    re.S,
)
_TAG_RE = re.compile(r"<[^>]+>")
# 地名含「/」「?」的確實存在,檔名要先淨化
_UNSAFE_RE = re.compile(r'[/\\:*?"<>|\s]+')


def _get(url: str) -> str:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
        return res.read().decode("utf-8", "replace")


def _text(raw: str) -> str:
    """Collapse the page's tag soup and NBSPs into a plain string."""
    return " ".join(_TAG_RE.sub("", raw).replace("\xa0", " ").split())


def safe_name(name: str) -> str:
    return _UNSAFE_RE.sub("_", name).strip("_") or "unnamed"


def lexicon_key(name: str) -> str:
    """同一地名的不同打法,站上用尾碼數字區分(基隆1/基隆2)——
    詞庫鍵取共同地名,變體靠 merge_lexicon 的 first-wins 收斂。"""
    return re.sub(r"\d+$", "", name).strip() or name


@dataclass
class Place:
    serno: int
    name: str
    county: str
    video_url: str
    morphemes: list[dict] = field(default_factory=list)

    @property
    def stem(self) -> str:
        """recordings/ 檔名主幹,沿用 twtsl 的 `NNNN_詞` 形式並加來源前綴。"""
        return f"pn_{self.serno:04d}_{safe_name(self.name)}"

    @property
    def description(self) -> str:
        """各字素的打法描述串起來 —— 對應 twtsl 詞條的 `text` 欄位。"""
        return " ".join(m["打法描述"] for m in self.morphemes if m.get("打法描述"))

    def to_dict(self) -> dict:
        return {
            "serno": self.serno,
            "name": self.name,
            "county": self.county,
            "video_url": self.video_url,
            "morphemes": self.morphemes,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Place:
        return cls(
            serno=int(d["serno"]),
            name=d["name"],
            county=d.get("county", ""),
            video_url=d["video_url"],
            morphemes=d.get("morphemes", []),
        )


def parse_morphemes(html: str) -> list[dict]:
    """One dict per 字素, in page order; fields the page omits are absent."""
    heads = list(_MORPH_HEAD_RE.finditer(html))
    out = []
    for i, head in enumerate(heads):
        end = heads[i + 1].start() if i + 1 < len(heads) else len(html)
        fields = {k: _text(v) for k, v in _FIELD_RE.findall(html[head.end() : end])}
        out.append({"字素": _text(head.group(1)), **{k: v for k, v in fields.items() if v}})
    return out


def fetch_county(local_id: int, fetch: Callable[[str], str] = _get) -> list[tuple[int, str]]:
    """[(serno, 地名)] listed for one county (右側結果選單, not the nav bar)."""
    html = fetch(f"{BASE_URL}placenames_database.php?searchtp=0&&localname={local_id}")
    start, end = html.find("right_menu"), html.find("right_advertisement")
    segment = html[start:end] if 0 <= start < end else html
    return [(int(s), n.strip()) for s, n in _LINK_RE.findall(segment)]


def fetch_index(fetch: Callable[[str], str] = _get, sleep=None) -> dict[int, str]:
    """serno → 縣市, over all 19 counties. A place listed under two counties
    keeps the first (the site does this for a handful of border places)."""
    index: dict[int, str] = {}
    for local_id, county in COUNTIES.items():
        for serno, _name in fetch_county(local_id, fetch=fetch):
            index.setdefault(serno, county)
        if sleep:
            sleep()
    return index


def fetch_place(serno: int, county: str = "", fetch: Callable[[str], str] = _get) -> Place:
    """Detail page: 地名 + video URL + per-morpheme 構詞分析."""
    html = fetch(f"{BASE_URL}areavideo.php?serno={serno}&&areaname=&&maxrows=0&&searchtp=0")
    video = _VIDEO_RE.search(html)
    if not video:
        raise ValueError(f"serno={serno}: 詳細頁沒有 <source> 影片")
    title = _TITLE_RE.search(html)
    return Place(
        serno=serno,
        name=_text(title.group(1)) if title else f"serno{serno}",
        county=county,
        video_url=BASE_URL + video.group(1).removeprefix("./"),
        morphemes=parse_morphemes(html),
    )


def fetch_all_places(fetch: Callable[[str], str] = _get, sleep=None, log=print) -> list[Place]:
    """Whole site: county index first, then every detail page."""
    index = fetch_index(fetch=fetch, sleep=sleep)
    places = []
    for i, (serno, county) in enumerate(sorted(index.items()), 1):
        try:
            places.append(fetch_place(serno, county, fetch=fetch))
        except Exception as ex:
            log(f"  serno={serno}: 詳細頁失敗 ({ex})")
            continue
        if log and i % 100 == 0:
            log(f"  詳細頁 {i}/{len(index)}")
        if sleep:
            sleep()
    return places


def download_video(place: Place, dest_dir: str | Path, fetch_bytes=None) -> Path:
    """Save the clip as recordings/pn_<serno>_<地名>.mp4; existing file wins.
    Writes through a .part file so an interrupted run leaves no half video."""
    dest = Path(dest_dir) / f"{place.stem}.mp4"
    if dest.is_file():
        return dest
    if fetch_bytes is None:

        def fetch_bytes(url: str) -> bytes:
            req = urllib.request.Request(url, headers={"User-Agent": _UA})
            with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
                return res.read()

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".mp4.part")
    tmp.write_bytes(fetch_bytes(place.video_url))
    tmp.replace(dest)
    return dest
