"""台灣手語姓氏網 (jung-hsingchang.tw/name/familynames_database.php) scraper.

同一個研究室、同一套 2010 年的 Dreamweaver 樣板,只是換了資料庫:335 個
姓氏,每個一支手語影片 + 逐字素構詞分析。解析直接沿用 `placenames` 那支
(該模組的 class 樣式已放寬成 `style7\\d*`,因為姓氏頁用的是 `style71`)。

與地名站的差異:
- 整份清單就在索引頁一頁裡,不必逐縣市掃,也附筆畫數
- `serno` 才是主鍵;URL 上的 `firstname` 參數會被站方忽略
- 影片是 `admin/upload/f_<serno:03d>.mp4`(地名是 `p_`)

授權同 [[placenames]]:站上無開放宣告,已另行取得研究室使用同意;
**同意的是使用不是公開**,訓練資料不對外公開、影片與萃取結果不散布。

Network entry points take an injectable transport; tests never hit the site.
"""

from __future__ import annotations

import re
import urllib.parse
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

from signavatar.placenames import BASE_URL, _get, parse_morphemes, safe_name

_LINK_RE = re.compile(
    r"namevideo\.php\?searchtp=10&&countno=(\d+)&&firstname=([^&\"]+)&&serno=(\d+)"
)
_VIDEO_RE = re.compile(r'<source\s+src="([^"]+\.mp4)"')

# 詞庫既有的姓氏詞條寫成「丁(姓)」(twtsl 的慣例),沿用它
_SURNAME_SUFFIX = "(姓)"


@dataclass
class Surname:
    serno: int
    name: str
    stroke: int = 0
    video_url: str = ""
    morphemes: list[dict] = field(default_factory=list)

    @property
    def stem(self) -> str:
        return f"fn_{self.serno:04d}_{safe_name(self.name)}"

    @property
    def description(self) -> str:
        return " ".join(m["打法描述"] for m in self.morphemes if m.get("打法描述"))

    def lexicon_keys(self) -> list[str]:
        """「林(姓)」與裸字「林」。前者不會跟一般詞撞名,後者才是模型實際會
        輸出的形式;裸字若已被一般詞占用,merge 時自然保留既有的那個。"""
        return [f"{self.name}{_SURNAME_SUFFIX}", self.name]

    def to_dict(self) -> dict:
        return {"serno": self.serno, "name": self.name, "stroke": self.stroke,
                "video_url": self.video_url, "morphemes": self.morphemes}

    @classmethod
    def from_dict(cls, d: dict) -> Surname:
        return cls(serno=int(d["serno"]), name=d["name"], stroke=int(d.get("stroke", 0)),
                   video_url=d.get("video_url", ""), morphemes=d.get("morphemes", []))


def fetch_index(fetch: Callable[[str], str] = _get) -> dict[int, tuple[str, int]]:
    """serno → (姓, 筆畫)。整份清單在索引頁一頁裡。"""
    html = fetch(f"{BASE_URL}familynames_database.php")
    index: dict[int, tuple[str, int]] = {}
    for stroke, name, serno in _LINK_RE.findall(html):
        index.setdefault(int(serno), (urllib.parse.unquote(name).strip(), int(stroke)))
    return index


def fetch_surname(
    serno: int, name: str = "", stroke: int = 0, fetch: Callable[[str], str] = _get
) -> Surname:
    """詳細頁:影片 + 構詞分析。姓與筆畫從索引頁帶進來(詳細頁的標題位置
    跟地名站不同,索引頁那份更可靠)。"""
    html = fetch(f"{BASE_URL}namevideo.php?searchtp=10&&countno={stroke}&&serno={serno}")
    video = _VIDEO_RE.search(html)
    if not video:
        raise ValueError(f"serno={serno}: 詳細頁沒有 <source> 影片")
    return Surname(
        serno=serno,
        name=name or f"serno{serno}",
        stroke=stroke,
        video_url=BASE_URL + video.group(1).removeprefix("./"),
        morphemes=parse_morphemes(html),
    )


def fetch_all(fetch: Callable[[str], str] = _get, sleep=None, log=print) -> list[Surname]:
    index = fetch_index(fetch=fetch)
    out = []
    for i, (serno, (name, stroke)) in enumerate(sorted(index.items()), 1):
        try:
            out.append(fetch_surname(serno, name, stroke, fetch=fetch))
        except Exception as ex:
            log(f"  serno={serno} {name}: 詳細頁失敗 ({ex})")
            continue
        if log and i % 50 == 0:
            log(f"  詳細頁 {i}/{len(index)}")
        if sleep:
            sleep()
    return out


def download_video(surname: Surname, dest_dir: str | Path, fetch_bytes=None) -> Path:
    """存成 recordings/fn_<serno>_<姓>.mp4;經 .part 落地,中斷不留半支影片。"""
    import urllib.request

    dest = Path(dest_dir) / f"{surname.stem}.mp4"
    if dest.is_file():
        return dest
    if fetch_bytes is None:

        def fetch_bytes(url: str) -> bytes:
            req = urllib.request.Request(
                url, headers={"User-Agent": "Mozilla/5.0 (signavatar research crawler)"}
            )
            with urllib.request.urlopen(req, timeout=60) as res:
                return res.read()

    dest.parent.mkdir(parents=True, exist_ok=True)
    tmp = dest.with_suffix(".mp4.part")
    tmp.write_bytes(fetch_bytes(surname.video_url))
    tmp.replace(dest)
    return dest
