"""臺灣手語新詞數位學習網 (newtsl.taslifamily.org) scraper.

社團法人臺灣手語翻譯協會蒐集的「新詞」手語:每個詞一支詞彙影片 + 一支例句
影片,都掛在 YouTube。收的是時事、品牌、科技、醫療這類辭典來不及收的詞
(川普、台積電、小紅書、載具、葉克膜),用來擴充虛擬人的實用詞彙。

站是 Google Sites。導覽列與內文是前端渲染的,但 **連結與 iframe 的
aria-label 都在原始 HTML 裡**,所以純 HTTP + regex 就抓得完,不必開瀏覽器。
枚舉要靠索引頁聯集:每頁的導覽只展開當前區塊(約 163/518),把 15 個主題頁
與 8 個年度頁掃過一遍才湊得齊。

Network entry points take an injectable transport; tests never hit the site.
"""

from __future__ import annotations

import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

BASE_URL = "https://newtsl.taslifamily.org"
_TIMEOUT_S = 60
_UA = "Mozilla/5.0 (signavatar research crawler)"

_SECTION_RE = re.compile(r'href="(/(?:年度檢索|主題探索)/[^"]+)"')
_WORD_LINK_RE = re.compile(r'href="/新詞彙/(\d{5})_([^"]+)"')
# iframe 的 aria-label 標明這支是「手語詞彙」還是「手語句子」
_VIDEO_RE = re.compile(
    r'aria-label="YouTube Video,\s*(.*?)"[^>]*src="https://www\.youtube\.com/embed/([\w-]{11})'
)
_PAGE_TITLE_RE = re.compile(r'"pageTitle":"\d{5}_([^"]+)"')
_SENTENCE_MARK = re.compile(r"句子|例句")
_UNSAFE_RE = re.compile(r'[/\\:*?"<>|\s]+')


def _get(path: str) -> str:
    req = urllib.request.Request(
        BASE_URL + urllib.parse.quote(path), headers={"User-Agent": _UA}
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
        return res.read().decode("utf-8", "replace")


def safe_name(name: str) -> str:
    return _UNSAFE_RE.sub("_", name).strip("_") or "unnamed"


def lexicon_keys(word: str) -> list[str]:
    """「優步（Uber）」→ ['優步', 'Uber'];括號裡多半是俗名或英文原名,
    兩種寫法都該查得到,所以各給一個詞條鍵(指向同一支影片)。"""
    parts = re.split(r"[（(]([^）)]*)[）)]", word)
    keys = [p.strip() for p in parts if p and p.strip()]
    return list(dict.fromkeys(keys)) or [word.strip()]


@dataclass
class Entry:
    wid: str
    word: str
    videos: dict[str, str] = field(default_factory=dict)   # 種類 → youtube id

    @property
    def stem(self) -> str:
        return f"tasli_{self.wid}_{safe_name(self.word)}"

    @property
    def word_video(self) -> str | None:
        """詞彙影片(不是例句)——詞條要的是這支。

        用排除法而不是正面列舉:站上的詞彙標籤跨年份至少有五種寫法
        (手語詞彙/- 詞彙/詞彙/- 詞𢑥/手語辭彙,早期批次甚至直接拿詞名當
        標籤),但例句那支一定帶「句子」或「例句」,認得出來。
        """
        for kind, vid in self.videos.items():
            if not _SENTENCE_MARK.search(kind):
                return vid
        return None

    def to_dict(self) -> dict:
        return {"wid": self.wid, "word": self.word, "videos": self.videos}

    @classmethod
    def from_dict(cls, d: dict) -> Entry:
        return cls(wid=d["wid"], word=d["word"], videos=d.get("videos", {}))


def fetch_index(fetch: Callable[[str], str] = _get, sleep=None, log=print) -> dict[str, str]:
    """編號 → 詞（URL 上的寫法）。掃所有索引頁取聯集。"""
    sections = sorted(set(_SECTION_RE.findall(fetch("/年度檢索"))))
    words: dict[str, str] = {}
    for i, section in enumerate(sections, 1):
        try:
            html = fetch(urllib.parse.unquote(section))
        except Exception as ex:
            log(f"  {section}: FAILED ({ex})")
            continue
        words.update(dict(_WORD_LINK_RE.findall(html)))
        if log:
            log(f"  [{i}/{len(sections)}] {urllib.parse.unquote(section)} → 累計 {len(words)}")
        if sleep:
            sleep()
    return dict(sorted(words.items()))


def fetch_entry(wid: str, url_word: str, fetch: Callable[[str], str] = _get) -> Entry:
    """詞頁:正式詞形 + 兩支影片的 YouTube id。"""
    html = fetch(f"/新詞彙/{wid}_{url_word}")
    title = _PAGE_TITLE_RE.search(html)
    word = title.group(1) if title else url_word
    videos: dict[str, str] = {}
    for label, vid in _VIDEO_RE.findall(html):
        kind = label.replace(word, "").replace(url_word, "").strip() or label.strip()
        videos.setdefault(kind, vid)
    return Entry(wid=wid, word=word, videos=videos)


def fetch_all(fetch: Callable[[str], str] = _get, sleep=None, log=print) -> list[Entry]:
    index = fetch_index(fetch=fetch, sleep=sleep, log=log)
    entries = []
    for i, (wid, url_word) in enumerate(index.items(), 1):
        try:
            entries.append(fetch_entry(wid, url_word, fetch=fetch))
        except Exception as ex:
            log(f"  {wid}_{url_word}: FAILED ({ex})")
            continue
        if log and i % 50 == 0:
            log(f"  詞頁 {i}/{len(index)}")
        if sleep:
            sleep()
    return entries


def download_video(entry: Entry, dest_dir: str | Path, download=None) -> Path | None:
    """把詞彙影片抓成 recordings/tasli_<編號>_<詞>.mp4;沒有詞彙影片就跳過。"""
    vid = entry.word_video
    if not vid:
        return None
    dest = Path(dest_dir) / f"{entry.stem}.mp4"
    if dest.is_file():
        return dest
    if download is None:
        from signavatar.moe_dict import download_youtube as download
    return download(vid, dest)
