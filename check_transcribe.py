"""實測生成頁的語音輸入：把錄音檔送進 bundle_server 同一套 Gemini 轉寫流程。

不經過網頁、不開伺服器，直接呼叫 bundle_server.transcribe()，所以測到的就是
線上那條路（主模型 → 空的就改 flash-lite → 轉臺灣繁體）。會真的打 Gemini、
真的計費（一句約台幣 1 分錢）。

金鑰從環境變數 GEMINI_API_KEY 讀，沒有就讀同目錄 .env 的 GEMINI_API_KEY=。

    # 單檔：印出轉寫結果、用了哪個模型、花多久
    .venv/bin/python3 check_transcribe.py 錄音.webm

    # 準確度：清單每行「音檔<TAB>正確句子」，最後印出平均字錯誤率
    .venv/bin/python3 check_transcribe.py --manifest 測試句.tsv

    # 手邊沒有錄音（macOS）：用內建的臺灣國語語音 Meijia 合成一句來測通路
    say -v Meijia -o /tmp/s.aiff "你明天要去醫院嗎" && afconvert -f WAVE -d LEI16@16000 /tmp/s.aiff /tmp/s.wav
    python3 check_transcribe.py /tmp/s.wav
"""

from __future__ import annotations

import argparse
import importlib.util
import mimetypes
import os
from pathlib import Path
import re
import sys
import time

ROOT = Path(__file__).resolve().parent
MIME_BY_SUFFIX = {
    ".webm": "audio/webm", ".ogg": "audio/ogg", ".opus": "audio/opus", ".wav": "audio/wav",
    ".mp3": "audio/mp3", ".m4a": "audio/m4a", ".mp4": "audio/m4a", ".aac": "audio/aac",
    ".flac": "audio/flac",
}
# 比對時不算標點與空白：「嗎？」和「嗎」聽寫上是同一句
IGNORED = re.compile(r"[\s　-〿＀-／：-＠,.!?;:'\"()\[\]-]")


def load_key() -> None:
    if os.environ.get("GEMINI_API_KEY", "").strip():
        return
    env = ROOT / ".env"
    if env.is_file():
        for line in env.read_text(encoding="utf-8").splitlines():
            if line.startswith("GEMINI_API_KEY="):
                os.environ["GEMINI_API_KEY"] = line.split("=", 1)[1].strip().strip("\"'")
    if not os.environ.get("GEMINI_API_KEY", "").strip():
        sys.exit("找不到 GEMINI_API_KEY（環境變數或 .env 都沒有）")


def load_bundle():
    spec = importlib.util.spec_from_file_location("bundle_server", ROOT / "bundle_server.py")
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


def char_error_rate(reference: str, hypothesis: str) -> float:
    ref, hyp = IGNORED.sub("", reference), IGNORED.sub("", hypothesis)
    if not ref:
        return 0.0 if not hyp else 1.0
    previous = list(range(len(hyp) + 1))
    for i, r in enumerate(ref, 1):
        current = [i]
        for j, h in enumerate(hyp, 1):
            current.append(min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + (r != h)))
        previous = current
    return previous[-1] / len(ref)


def run_one(bundle, path: Path) -> tuple[dict, float]:
    mime = MIME_BY_SUFFIX.get(path.suffix.lower()) or mimetypes.guess_type(path.name)[0] or "audio/wav"
    started = time.perf_counter()
    result = bundle.transcribe(path.read_bytes(), mime)
    return result, time.perf_counter() - started


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("audio", nargs="*", type=Path, help="錄音檔")
    parser.add_argument("--manifest", type=Path, help="每行：音檔<TAB>正確句子")
    args = parser.parse_args()
    if not args.audio and not args.manifest:
        parser.error("給一個錄音檔，或用 --manifest")

    load_key()
    bundle = load_bundle()
    if bundle.TO_TRADITIONAL is None:
        print("⚠ 沒裝 OpenCC：結果不會轉臺灣繁體（.venv/bin/pip install opencc）\n")

    for path in args.audio:
        result, seconds = run_one(bundle, path)
        print(f"{path.name}\t{seconds:.1f}s\t{result['model']}\t{result['text'] or '（空的）'}")

    if args.manifest:
        rates = []
        base = args.manifest.resolve().parent
        for line in args.manifest.read_text(encoding="utf-8").splitlines():
            if not line.strip() or line.startswith("#"):
                continue
            name, reference = line.split("\t", 1)
            result, seconds = run_one(bundle, base / name)
            rate = char_error_rate(reference, result["text"])
            rates.append(rate)
            print(f"{name}\t{seconds:.1f}s\tCER {rate:.0%}\t{result['model']}\n  正確：{reference}\n  聽到：{result['text']}")
        if rates:
            print(f"\n共 {len(rates)} 句，平均字錯誤率 {sum(rates) / len(rates):.1%}")


if __name__ == "__main__":
    main()
