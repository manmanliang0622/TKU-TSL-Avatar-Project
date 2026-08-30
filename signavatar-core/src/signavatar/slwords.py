"""臺灣手語詞庫 (idl.nutc.edu.tw/slwords) client.

國立臺灣圖書館「國家語言文獻典藏及數位化實施計畫」蒐集臺灣手語電子繪本裡的
詞語:644 個詞各一支標準示範影片,其中 457 個另有多位聾人演繹者各錄一次
(實測每詞約 27–31 位)。

站是 Vue SPA,資料全走兩個 JSON 端點:
- `GET /getwords` → 644 詞 metadata(注音、議題分類、所屬繪本、長度)
- `POST /recword {"name": 詞}` → **隨機**回一支該詞的演繹者錄影
  `{filename, presentor}`;**沒有列表端點**,要湊齊一個詞的所有版本只能重複
  抽樣(實測抽到第 60 次左右才打平)。

影片:標準版 `/words/<詞>.mp4`、演繹者版 `/words/recwords/<filename>.mp4`
(注意 `words/` 掛在網站根目錄,不是 `/slwords/words/`)。

**授權**:該站著作權宣告明訂「未經本館或各著作財產權人之書面同意,不得擅自
重製、改作、散布」,比本專案其他來源嚴格。抓下來的資料一律不對外散布,
正式使用前應向國立臺灣圖書館(viic@mail.ntl.edu.tw)洽詢書面同意。

Network entry points take an injectable transport; tests never hit the site.
"""

from __future__ import annotations

import json
import re
import urllib.parse
import urllib.request
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path

BASE_URL = "https://idl.nutc.edu.tw"
_TIMEOUT_S = 60
_UA = "Mozilla/5.0 (signavatar research crawler)"
_UNSAFE_RE = re.compile(r'[/\\:*?"<>|\s]+')

LICENSE_NOTE = (
    "國立臺灣圖書館 臺灣手語電子繪本/手語詞庫;著作權宣告明訂未經書面同意不得重製、"
    "改作、散布——訓練資料不對外公開,正式使用前需洽本館取得書面同意"
)


def _get_json(path: str) -> dict:
    req = urllib.request.Request(BASE_URL + path, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
        return json.loads(res.read())


def _post_json(path: str, payload: dict) -> dict:
    req = urllib.request.Request(
        BASE_URL + path,
        data=json.dumps(payload).encode("utf-8"),
        headers={"Content-Type": "application/json; charset=utf-8", "User-Agent": _UA},
    )
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
        return json.loads(res.read())


def safe_name(name: str) -> str:
    return _UNSAFE_RE.sub("_", name).strip("_") or "unnamed"


def lexicon_keys(name: str) -> list[str]:
    """「電(B)」→ ['電(B)', '電']:括號裡是同義異形的標記(A/B 兩種打法),
    光桿詞也該查得到,但要不要真的佔用光桿鍵由呼叫端判斷(不覆蓋既有詞條)。"""
    bare = re.sub(r"[（(][^）)]*[）)]", "", name).strip()
    return [name] + ([bare] if bare and bare != name else [])


@dataclass
class Word:
    wid: str
    name: str
    phonetic: str = ""
    categories: list[int] = field(default_factory=list)
    book_id: int | None = None
    duration_ms: int = 0
    has_recordings: bool = False        # 站上的 AI 旗標:有沒有多演繹者錄影
    recordings: dict[str, str] = field(default_factory=dict)  # filename → 演繹者

    @property
    def stem(self) -> str:
        return f"slw_{safe_name(self.name)}"

    @property
    def video_url(self) -> str:
        return f"{BASE_URL}/words/{urllib.parse.quote(self.name)}.mp4"

    def to_dict(self) -> dict:
        return {
            "wid": self.wid,
            "name": self.name,
            "phonetic": self.phonetic,
            "categories": self.categories,
            "book_id": self.book_id,
            "duration_ms": self.duration_ms,
            "has_recordings": self.has_recordings,
            "recordings": self.recordings,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Word:
        return cls(
            wid=d["wid"],
            name=d["name"],
            phonetic=d.get("phonetic", ""),
            categories=d.get("categories") or [],
            book_id=d.get("book_id"),
            duration_ms=d.get("duration_ms", 0),
            has_recordings=d.get("has_recordings", False),
            recordings=d.get("recordings") or {},
        )


def fetch_words(fetch: Callable[[str], dict] = _get_json) -> tuple[list[Word], dict]:
    """回傳 (詞表, 分類/注音/繪本對照表)。"""
    data = fetch("/getwords")
    words = [
        Word(
            wid=w.get("_id", ""),
            name=w["name"],
            phonetic=(w.get("Phonetic") or "").strip(),
            categories=w.get("category") or [],
            book_id=w.get("bookid"),
            duration_ms=w.get("duration") or 0,
            has_recordings=w.get("AI") == "T",
        )
        for w in data.get("words", [])
        if w.get("name")
    ]
    tables = {
        "category": data.get("category") or [],
        "phonetics": data.get("phonetics") or [],
        "pbook": data.get("pbook") or [],
    }
    return words, tables


def sample_recordings(
    word: Word,
    samples: int = 120,
    post: Callable[[str, dict], dict] = _post_json,
    sleep=None,
    stop_after_idle: int = 25,
) -> dict[str, str]:
    """重複抽樣 `/recword` 湊齊一個詞的演繹者錄影;連續 `stop_after_idle` 次
    抽不到新的就提早收工(固定抽滿 samples 次是浪費請求)。"""
    found = dict(word.recordings)
    idle = 0
    for _ in range(samples):
        try:
            res = post("/recword", {"name": word.name})
        except Exception:
            break
        name = res.get("filename")
        if not name:
            break
        if name in found:
            idle += 1
            if idle >= stop_after_idle:
                break
        else:
            found[name] = res.get("presentor") or ""
            idle = 0
        if sleep:
            sleep()
    return found


def recording_url(filename: str) -> str:
    return f"{BASE_URL}/words/recwords/{urllib.parse.quote(filename)}.mp4"


def _download(url: str, dest: Path) -> Path:
    req = urllib.request.Request(url, headers={"User-Agent": _UA})
    with urllib.request.urlopen(req, timeout=_TIMEOUT_S) as res:
        data = res.read()
    dest.write_bytes(data)
    return dest


def download_video(word: Word, dest_dir: str | Path, download=_download) -> Path | None:
    dest = Path(dest_dir) / f"{word.stem}.mp4"
    if dest.is_file():
        return dest
    return download(word.video_url, dest)


def download_recording(
    word: Word, filename: str, seq: int, dest_dir: str | Path, download=_download
) -> Path | None:
    """演繹者錄影存成 `<詞>/<序號>_<站上檔名>.mp4`;**檔名不放演繹者本名**。"""
    folder = Path(dest_dir) / safe_name(word.name)
    folder.mkdir(parents=True, exist_ok=True)
    dest = folder / f"{seq:02d}_{filename}.mp4"
    if dest.is_file():
        return dest
    return download(recording_url(filename), dest)
