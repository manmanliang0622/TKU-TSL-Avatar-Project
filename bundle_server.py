#!/usr/bin/env python3
"""Single HTTP entry point for the self-contained 0813 project."""

from __future__ import annotations

import argparse
import base64
from collections import OrderedDict, deque
from email.utils import formatdate
import gzip
import hashlib
import http.client
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
from pathlib import PurePosixPath
import signal
import ssl
import subprocess
import threading
import time
from typing import Any
import urllib.error
from urllib.parse import parse_qs, unquote, urlsplit
import urllib.request


ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
MODEL_PORT = 8877
# 手語辨識端（~/knee42 的 Knee42 webservice），自簽 TLS、只綁 127.0.0.1。
# 前端走同源 /knee42/* 由本服務轉發，避免瀏覽器面對自簽憑證與 CORS。
KNEE42_PORT = int(os.environ.get("KNEE42_PORT", "8642"))
KNEE42_MAX_BODY = 32 * 1024 * 1024
MODEL_PROC: subprocess.Popen[bytes] | None = None
MODEL_LOCK = threading.Lock()
MODEL_LOG = None
MODEL_ERR = None
# 0821 服務的是新格式（tsl-script-v1）的 v14，與 0813 的 v11 是不同任務：
# 模型輸出 sign_id 而非 gloss 字串。這個字串會被 /health 的 model_identity_ok
# 檢查比對，改錯會讓服務一直判定「載到錯的模型」。
EXPECTED_MODEL = "qlora_e4b_v21script"
INFERENCE_LOCK = threading.Lock()
STOP_EVENT = threading.Event()
MODEL_RESTART_COUNT = 0
MODEL_RESTART_EXHAUSTED = False
MODEL_MAX_RESTARTS = int(os.environ.get("MODEL_MAX_RESTARTS", "3"))
PUBLIC_DIRECTORIES = {"models", "recordings", "vendor", "audit-frames"}
# 詞條切片快取：整支錄影檔動輒 10-80 MB，前端每個詞只需要其中 0.3-3 秒。
# 切好的片段存在這裡（gzip），下次同一個詞就直接送檔，不必再讀原檔。
CLIP_CACHE = ROOT / "clip_cache"
CLIP_MAX_BATCH = 96
CLIP_LOCK_TABLE: dict[str, threading.Lock] = {}
CLIP_LOCK_TABLE_LOCK = threading.Lock()
CLIP_META_KEYS = ("version", "label", "fps", "source_width", "source_height", "created_at")
# 靜態檔壓縮：lexicon.json 3.1 MB 壓完剩約 0.5 MB。上限擋住整支錄影檔，
# 那種尺寸現壓比直接送還慢，而且切片端點已經讓前端不必抓整支。
GZIP_SUFFIXES = {".css", ".html", ".js", ".json", ".svg", ".txt", ".xml"}
GZIP_MIN_BYTES = 1024
GZIP_MAX_BYTES = 8 * 1024 * 1024
# 同一句重打不必再等模型：生成是 greedy（do_sample=False），同樣的輸入必得同樣
# 的輸出，所以存起來直接回是同一個答案，不是近似。示範時同一句會講很多次，
# 這四秒省下來最有感。
TRANSLATE_CACHE: "OrderedDict[tuple[str, str], bytes]" = OrderedDict()
TRANSLATE_CACHE_MAX = 256
TRANSLATE_CACHE_LOCK = threading.Lock()


def cached_translation(key: tuple[str, str]) -> bytes | None:
    with TRANSLATE_CACHE_LOCK:
        body = TRANSLATE_CACHE.get(key)
        if body is not None:
            TRANSLATE_CACHE.move_to_end(key)
        return body


def remember_translation(key: tuple[str, str], body: bytes) -> None:
    with TRANSLATE_CACHE_LOCK:
        TRANSLATE_CACHE[key] = body
        TRANSLATE_CACHE.move_to_end(key)
        while len(TRANSLATE_CACHE) > TRANSLATE_CACHE_MAX:
            TRANSLATE_CACHE.popitem(last=False)


# 語音輸入（生成頁「按住說話」）：瀏覽器錄一句話送來，這裡轉給 Gemini 轉成
# 文字，填回輸入框讓使用者看過、改過再按「轉成手語」。金鑰只在這台主機的
# 環境變數裡，前端與 Pages 都拿不到。沒設金鑰時 /transcribe 回 503，其餘照常。
GEMINI_API_ROOT = "https://generativelanguage.googleapis.com/v1beta"
TRANSCRIBE_MODEL = os.environ.get("TRANSCRIBE_MODEL", "gemini-3.5-transcribe")
# gemini-3.5-transcribe 有「HTTP 200 但內容全空」的回報（Google AI 論壇，
# 2026-08 起未解）。空的或出錯就改用 flash-lite 加提示詞轉寫；這條路可以
# 直接要求臺灣繁體，單價也更低。
TRANSCRIBE_FALLBACK_MODEL = os.environ.get("TRANSCRIBE_FALLBACK_MODEL", "gemini-3.5-flash-lite")
TRANSCRIBE_FALLBACK_PROMPT = (
    "逐字轉寫這段語音。只輸出轉寫的文字，使用臺灣繁體中文與全形標點，"
    "不要加任何說明、引號或換行。聽不到人聲就輸出空字串。"
)
# 官方語言表的普通話只有簡體（cmn-Hans-CN），沒有 zh-TW；結果一律再轉臺灣繁體
TRANSCRIBE_LANGUAGES = [
    code.strip() for code in os.environ.get("TRANSCRIBE_LANGUAGES", "cmn-Hans-CN").split(",") if code.strip()
]
# 前端錄音上限 15 秒、32 kbps Opus 約 60 KB；留給 Safari 的 AAC 一點餘裕
TRANSCRIBE_MAX_BODY = 512 * 1024
TRANSCRIBE_MIME_TYPES = {
    "audio/webm", "audio/ogg", "audio/opus", "audio/wav", "audio/mpeg", "audio/mp3",
    "audio/aac", "audio/m4a", "audio/flac",
}
# Safari 的 MediaRecorder 只出 audio/mp4（AAC），Gemini 的 MIME 清單叫它 m4a
TRANSCRIBE_MIME_ALIASES = {"audio/mp4": "audio/m4a", "audio/x-m4a": "audio/m4a", "audio/wave": "audio/wav"}
# 防濫用：這支 API 照用量計費，網址又是公開的。單一來源每分鐘有上限；
# 全站每天也有上限 —— 1000 次 × 15 秒 ≈ 250 分鐘音訊，最壞一天不到 2 美元。
# 真正的硬上限還是 Google Cloud 那邊的配額，這裡是第一道。
TRANSCRIBE_PER_CLIENT_PER_MINUTE = int(os.environ.get("TRANSCRIBE_PER_CLIENT_PER_MINUTE", "10"))
TRANSCRIBE_PER_DAY = int(os.environ.get("TRANSCRIBE_PER_DAY", "1000"))
TRANSCRIBE_TIMEOUT = 30


class TranscribeLimiter:
    """Sliding-window limits: per client per minute, and for the whole site per day."""

    def __init__(self, per_client_per_minute: int, per_day: int, clock=time.monotonic) -> None:
        self.per_client_per_minute = per_client_per_minute
        self.per_day = per_day
        self.clock = clock
        self.lock = threading.Lock()
        self.day: deque[float] = deque()
        self.clients: dict[str, deque[float]] = {}

    def allow(self, client: str) -> str | None:
        """Record one request and return None, or return why it is refused."""
        now = self.clock()
        with self.lock:
            while self.day and now - self.day[0] >= 86_400:
                self.day.popleft()
            for key in [key for key, hits in self.clients.items() if not hits or now - hits[-1] >= 60]:
                del self.clients[key]
            hits = self.clients.setdefault(client, deque())
            while hits and now - hits[0] >= 60:
                hits.popleft()
            if len(self.day) >= self.per_day:
                return "今天的語音輸入次數已達上限，請改用打字輸入。"
            if len(hits) >= self.per_client_per_minute:
                return "語音輸入太頻繁，請稍等一分鐘再試。"
            self.day.append(now)
            hits.append(now)
            return None


TRANSCRIBE_LIMITER = TranscribeLimiter(TRANSCRIBE_PER_CLIENT_PER_MINUTE, TRANSCRIBE_PER_DAY)


def _traditional_converter():
    """OpenCC 簡轉臺灣繁體（含用詞）。沒裝就原樣回傳，/transcribe 的回應會標出來。"""
    try:
        import opencc  # type: ignore[import-not-found]
    except ImportError:
        return None
    # 官方套件吃 "s2twp.json"，opencc-python-reimplemented 吃 "s2twp"
    for config in ("s2twp.json", "s2twp"):
        try:
            return opencc.OpenCC(config).convert
        except Exception:  # noqa: BLE001 - 兩種套件丟的例外型別不同
            continue
    return None


TO_TRADITIONAL = _traditional_converter()


class TranscribeError(Exception):
    pass


def gemini_post(path: str, payload: dict[str, Any]) -> dict[str, Any]:
    key = os.environ.get("GEMINI_API_KEY", "").strip()
    request = urllib.request.Request(
        f"{GEMINI_API_ROOT}/{path}",
        data=json.dumps(payload).encode("utf-8"),
        # 金鑰放標頭不放網址：網址會進日誌與錯誤訊息
        headers={"Content-Type": "application/json", "x-goog-api-key": key},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=TRANSCRIBE_TIMEOUT) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as error:
        detail = error.read().decode("utf-8", "replace")[:300]
        raise TranscribeError(f"{path.split(':')[0]} HTTP {error.code}: {detail}") from error
    except (OSError, ValueError) as error:
        raise TranscribeError(f"{path.split(':')[0]}: {error}") from error


def transcribe_primary(audio_b64: str, mime: str) -> str:
    config: dict[str, Any] = {"mode": "smart"}
    if TRANSCRIBE_LANGUAGES:
        config["language_codes"] = TRANSCRIBE_LANGUAGES
    data = gemini_post("interactions", {
        "model": f"models/{TRANSCRIBE_MODEL}",
        "input": [{"type": "audio", "data": audio_b64, "mime_type": mime}],
        "generation_config": {"transcription_config": config},
    })
    texts = [
        block.get("text", "")
        for step in data.get("steps") or []
        if isinstance(step, dict) and step.get("type") == "model_output"
        for block in step.get("content") or []
        if isinstance(block, dict) and block.get("type") == "text"
    ]
    if not texts and isinstance(data.get("output_text"), str):
        texts = [data["output_text"]]
    return "".join(texts).strip()


def transcribe_fallback(audio_b64: str, mime: str) -> str:
    data = gemini_post(f"models/{TRANSCRIBE_FALLBACK_MODEL}:generateContent", {
        "contents": [{
            "role": "user",
            "parts": [
                {"inline_data": {"mime_type": mime, "data": audio_b64}},
                {"text": TRANSCRIBE_FALLBACK_PROMPT},
            ],
        }],
    })
    candidates = data.get("candidates") or [{}]
    parts = (candidates[0].get("content") or {}).get("parts") or []
    return "".join(part.get("text", "") for part in parts if isinstance(part, dict)).strip()


def transcribe(audio: bytes, mime: str) -> dict[str, Any]:
    audio_b64 = base64.b64encode(audio).decode("ascii")
    model = TRANSCRIBE_MODEL
    try:
        text = transcribe_primary(audio_b64, mime)
    except TranscribeError as error:
        print(f"[0813] transcribe: {TRANSCRIBE_MODEL} failed, falling back: {error}", flush=True)
        text = ""
    if not text:
        model = TRANSCRIBE_FALLBACK_MODEL
        text = transcribe_fallback(audio_b64, mime)
    text = " ".join(text.split())
    traditional = TO_TRADITIONAL is not None
    if traditional and text:
        text = TO_TRADITIONAL(text)
    return {"text": text, "model": model, "traditional": traditional}
PUBLIC_ROOT_SUFFIXES = {
    ".css",
    ".html",
    ".ico",
    ".jpeg",
    ".jpg",
    ".js",
    ".json",
    ".png",
    ".svg",
    ".txt",
    ".webp",
    ".xml",
}


def model_cmd(model_port: int) -> list[str]:
    """Return the v11 command using only files bundled inside this project."""
    return [
        str(ROOT / ".venv/bin/python3"),
        str(ROOT / "model_service/scripts/serve_model.py"),
        "--base",
        str(ROOT / "model_service/base_model"),
        "--adapter",
        str(ROOT / "model_service/checkpoint"),
        "--target",
        "script",
        "--model-name",
        EXPECTED_MODEL,
        "--port",
        str(model_port),
        # 腳本格式的輸出比舊 JSON 長（sign_ids 陣列＋oov_items），實測約 92 token。
        # 沿用預設 64 會把 JSON 截斷，變成 ValidJSON 掉到 0 而看起來像模型壞掉。
        "--max-new",
        "256",
        "--ple",
        os.environ.get("MODEL_PLE", "gpu"),
    ]


def model_request(
    method: str,
    path: str,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 10.0,
) -> tuple[int, list[tuple[str, str]], bytes]:
    connection = http.client.HTTPConnection("127.0.0.1", MODEL_PORT, timeout=timeout)
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.getheaders(), response.read()
    finally:
        connection.close()


def knee42_request(
    method: str,
    path: str,
    body: bytes | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 60.0,
) -> tuple[int, list[tuple[str, str]], bytes]:
    # 辨識端強制 TLS 且憑證是自簽的；只連本機 loopback，跳過驗證是安全的。
    context = ssl._create_unverified_context()
    connection = http.client.HTTPSConnection(
        "127.0.0.1", KNEE42_PORT, timeout=timeout, context=context
    )
    try:
        connection.request(method, path, body=body, headers=headers or {})
        response = connection.getresponse()
        return response.status, response.getheaders(), response.read()
    finally:
        connection.close()


def model_is_alive() -> bool:
    with MODEL_LOCK:
        return MODEL_PROC is not None and MODEL_PROC.poll() is None


def is_public_static_path(raw_path: str) -> bool:
    """Allow only front-end assets; never expose runtime, model, logs, or VCS data."""
    decoded_path = unquote(urlsplit(raw_path).path)
    parts = [part for part in PurePosixPath(decoded_path).parts if part not in {"/", ""}]
    if not parts:
        return True
    if any(part in {".", ".."} or part.startswith(".") for part in parts):
        return False
    if parts[0] in PUBLIC_DIRECTORIES:
        return True
    return len(parts) == 1 and Path(parts[0]).suffix.lower() in PUBLIC_ROOT_SUFFIXES


def recording_path(name: str) -> Path | None:
    """Resolve a recordings/ filename. Anything with a path in it is rejected."""
    if not name or not name.endswith(".json"):
        return None
    if name != PurePosixPath(name).name or name.startswith("."):
        return None
    path = ROOT / "recordings" / name
    return path if path.is_file() else None


def clip_cache_path(name: str, start: float, end: float) -> Path:
    digest = hashlib.sha1(f"{name}|{start:.4f}|{end:.4f}".encode("utf-8")).hexdigest()
    return CLIP_CACHE / digest[:2] / f"{digest}.json.gz"


def clip_lock(key: str) -> threading.Lock:
    with CLIP_LOCK_TABLE_LOCK:
        return CLIP_LOCK_TABLE.setdefault(key, threading.Lock())


def slice_recording(data: dict[str, Any], start: float, end: float) -> dict[str, Any]:
    """The frames a lexicon entry actually plays, plus the recording's own metadata."""
    frames = [
        frame
        for frame in data.get("frames", [])
        if isinstance(frame.get("timestamp"), (int, float))
        and start <= frame["timestamp"] <= end
    ]
    clip = {key: data.get(key) for key in CLIP_META_KEYS}
    clip["start"] = start
    clip["end"] = end
    clip["frames"] = frames
    return clip


def write_clip_cache(path: Path, payload: dict[str, Any]) -> bytes:
    """Store the clip gzipped, atomically, and hand back the compressed bytes."""
    raw = json.dumps(payload, ensure_ascii=False, separators=(",", ":")).encode("utf-8")
    blob = gzip.compress(raw, 6)
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_suffix(f".{os.getpid()}.{threading.get_ident()}.tmp")
    temporary.write_bytes(blob)
    temporary.replace(path)
    return blob


def build_clips(items: list[tuple[str, float, float]]) -> list[bytes | None]:
    """Compressed clip bytes for each request, parsing every recording at most once.

    Grouping matters: a sentence usually pulls several words out of the same
    interview recording, and parsing an 80 MB file once per word instead of
    once per file was the difference between one second and five.
    """
    results: list[bytes | None] = [None] * len(items)
    pending: dict[str, list[tuple[int, float, float]]] = {}
    for index, (name, start, end) in enumerate(items):
        cached = clip_cache_path(name, start, end)
        if cached.is_file():
            results[index] = cached.read_bytes()
        else:
            pending.setdefault(name, []).append((index, start, end))

    for name, requests in pending.items():
        source = recording_path(name)
        if source is None:
            continue
        with clip_lock(name):
            # another thread may have cut these while this one waited
            outstanding = [
                (index, start, end)
                for index, start, end in requests
                if not clip_cache_path(name, start, end).is_file()
            ]
            for index, start, end in requests:
                cached = clip_cache_path(name, start, end)
                if cached.is_file():
                    results[index] = cached.read_bytes()
            if not outstanding:
                continue
            try:
                with source.open("rb") as handle:
                    data = json.loads(handle.read().decode("utf-8"))
            except (OSError, UnicodeDecodeError, json.JSONDecodeError):
                continue
            for index, start, end in outstanding:
                clip = slice_recording(data, start, end)
                results[index] = write_clip_cache(clip_cache_path(name, start, end), clip)
            del data
    return results


def parse_clip_items(raw_items: Any) -> list[tuple[str, float, float]] | None:
    """Validate a batch request body into (name, start, end) triples."""
    if not isinstance(raw_items, list) or not raw_items or len(raw_items) > CLIP_MAX_BATCH:
        return None
    items: list[tuple[str, float, float]] = []
    for entry in raw_items:
        if not isinstance(entry, dict):
            return None
        name = entry.get("name")
        start = entry.get("start")
        end = entry.get("end")
        if not isinstance(name, str) or isinstance(start, bool) or isinstance(end, bool):
            return None
        if not isinstance(start, (int, float)) or not isinstance(end, (int, float)):
            return None
        if start != start or end != end or end < start:   # NaN never orders correctly
            return None
        items.append((name, float(start), float(end)))
    return items


def start_model() -> subprocess.Popen[bytes]:
    global MODEL_PROC, MODEL_LOG, MODEL_ERR
    with MODEL_LOCK:
        if MODEL_PROC is not None and MODEL_PROC.poll() is None:
            return MODEL_PROC
        LOG_DIR.mkdir(parents=True, exist_ok=True)
        if MODEL_LOG:
            MODEL_LOG.close()
        if MODEL_ERR:
            MODEL_ERR.close()
        MODEL_LOG = open(LOG_DIR / "v11-model.log", "ab", buffering=0)
        MODEL_ERR = open(LOG_DIR / "v11-model.err.log", "ab", buffering=0)
        environment = os.environ.copy()
        environment.setdefault("HF_HUB_OFFLINE", "1")
        environment.setdefault("TRANSFORMERS_OFFLINE", "1")
        environment["PYTHONNOUSERSITE"] = "1"
        MODEL_PROC = subprocess.Popen(
            model_cmd(MODEL_PORT),
            cwd=str(ROOT),
            env=environment,
            stdin=subprocess.DEVNULL,
            stdout=MODEL_LOG,
            stderr=MODEL_ERR,
        )
        (LOG_DIR / "v11-model.pid").write_text(f"{MODEL_PROC.pid}\n", encoding="utf-8")
        return MODEL_PROC


def supervise_model() -> None:
    """Restart a crashed model child a bounded number of times."""
    global MODEL_RESTART_COUNT, MODEL_RESTART_EXHAUSTED
    while not STOP_EVENT.wait(2):
        with MODEL_LOCK:
            process = MODEL_PROC
            exited = process is not None and process.poll() is not None
        if not exited:
            continue
        if MODEL_RESTART_COUNT >= MODEL_MAX_RESTARTS:
            MODEL_RESTART_EXHAUSTED = True
            print("[0813] v11 model restart limit reached", flush=True)
            return
        MODEL_RESTART_COUNT += 1
        delay = min(2 ** MODEL_RESTART_COUNT, 10)
        print(
            f"[0813] v11 model exited; restart "
            f"{MODEL_RESTART_COUNT}/{MODEL_MAX_RESTARTS} in {delay}s",
            flush=True,
        )
        if STOP_EVENT.wait(delay):
            return
        try:
            start_model()
        except OSError as error:
            print(f"[0813] v11 restart failed: {error}", flush=True)


def stop_model() -> None:
    global MODEL_PROC
    with MODEL_LOCK:
        process = MODEL_PROC
        MODEL_PROC = None
    if process is None or process.poll() is not None:
        return
    process.terminate()
    try:
        process.wait(timeout=15)
    except subprocess.TimeoutExpired:
        process.kill()
        process.wait(timeout=5)


class Handler(SimpleHTTPRequestHandler):
    server_version = "TSL0813/1.0"

    def __init__(self, *args: Any, **kwargs: Any) -> None:
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def log_message(self, format_string: str, *args: Any) -> None:
        print(f"[0813] {self.address_string()} {format_string % args}", flush=True)

    def end_headers(self) -> None:
        # pages.dev 等跨網域前端要在「每個」回應讀到 CORS 標頭，
        # 只放在 OPTIONS 預檢的話，瀏覽器會擋下真正的 POST/GET 結果。
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        # Chrome PNA：https 頁面（pages.dev）打 SSH tunnel 進來的 loopback 需要這行
        self.send_header("Access-Control-Allow-Private-Network", "true")
        super().end_headers()

    def send_json(self, status: int, payload: dict[str, Any]) -> None:
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def accepts_gzip(self) -> bool:
        return "gzip" in self.headers.get("Accept-Encoding", "").lower()

    def send_blob(self, blob: bytes, content_type: str, cache: str) -> None:
        """Send already-gzipped bytes, decompressing only for clients that ask."""
        gzipped = self.accepts_gzip()
        body = blob if gzipped else gzip.decompress(blob)
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        if gzipped:
            self.send_header("Content-Encoding", "gzip")
        self.send_header("Vary", "Accept-Encoding")
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", cache)
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def serve_clip_query(self) -> None:
        query = parse_qs(urlsplit(self.path).query)
        name = (query.get("name") or [""])[0]
        try:
            start = float((query.get("start") or ["nan"])[0])
            end = float((query.get("end") or ["nan"])[0])
        except ValueError:
            self.send_json(400, {"error": "start and end must be numbers"})
            return
        items = parse_clip_items([{"name": name, "start": start, "end": end}])
        if items is None or start != start or end != end:
            self.send_json(400, {"error": "name, start and end are required"})
            return
        if recording_path(name) is None:
            self.send_json(404, {"error": "recording not found"})
            return
        blob = build_clips(items)[0]
        if blob is None:
            self.send_json(404, {"error": "recording not found"})
            return
        # a clip is defined by its recording and its time range, so it never
        # changes; the browser may keep it for as long as it likes
        self.send_blob(blob, "application/json; charset=utf-8", "public, max-age=604800, immutable")

    def serve_clip_batch(self, body: bytes) -> None:
        """One round trip for a whole sentence, rather than one per word."""
        try:
            request_data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "request body must be UTF-8 JSON"})
            return
        if not isinstance(request_data, dict):
            self.send_json(400, {"error": "request body must be a JSON object"})
            return
        items = parse_clip_items(request_data.get("items"))
        if items is None:
            self.send_json(
                400,
                {"error": f"items must be 1-{CLIP_MAX_BATCH} objects of name/start/end"},
            )
            return
        blobs = build_clips(items)
        missing = [items[i][0] for i, blob in enumerate(blobs) if blob is None]
        parts = [b"null" if blob is None else gzip.decompress(blob) for blob in blobs]
        payload = b'{"clips":[' + b",".join(parts) + b'],"missing":'
        payload += json.dumps(missing, ensure_ascii=False).encode("utf-8") + b"}"
        self.send_blob(gzip.compress(payload, 6), "application/json; charset=utf-8", "no-store")

    def serve_static(self) -> None:
        """Static files, gzipped when it is worth it, with a revalidation window."""
        decoded = unquote(urlsplit(self.path).path)
        target = ROOT / decoded.lstrip("/")
        suffix = target.suffix.lower()
        if (
            self.command == "GET"
            and self.accepts_gzip()
            and suffix in GZIP_SUFFIXES
            and target.is_file()
        ):
            try:
                size = target.stat().st_size
            except OSError:
                size = 0
            if GZIP_MIN_BYTES <= size <= GZIP_MAX_BYTES:
                try:
                    raw = target.read_bytes()
                except OSError:
                    raw = None
                if raw is not None:
                    body = gzip.compress(raw, 6)
                    self.send_response(200)
                    self.send_header("Content-Type", self.guess_type(str(target)))
                    self.send_header("Content-Encoding", "gzip")
                    self.send_header("Vary", "Accept-Encoding")
                    self.send_header("Content-Length", str(len(body)))
                    self.send_header("Last-Modified", formatdate(target.stat().st_mtime, usegmt=True))
                    self.send_header("Cache-Control", "no-cache")
                    self.end_headers()
                    self.wfile.write(body)
                    return
        if self.command == "GET":
            super().do_GET()
        else:
            super().do_HEAD()

    def do_OPTIONS(self) -> None:
        self.send_response(204)
        self.end_headers()  # CORS 標頭由 end_headers 統一補上

    KNEE42_GET_ROUTES = frozenset({"/health", "/labels"})
    KNEE42_POST_ROUTES = frozenset({"/predict", "/stream"})

    def serve_knee42(self, route: str) -> None:
        upstream = route[len("/knee42"):]
        allowed = self.KNEE42_POST_ROUTES if self.command == "POST" else self.KNEE42_GET_ROUTES
        if upstream not in allowed:
            self.send_json(404, {"ok": False, "error": "not found"})
            return
        body = None
        headers: dict[str, str] = {}
        if self.command == "POST":
            try:
                content_length = int(self.headers.get("Content-Length", "0"))
            except ValueError:
                self.send_json(400, {"ok": False, "error": "invalid Content-Length"})
                return
            if content_length <= 0 or content_length > KNEE42_MAX_BODY:
                self.send_json(400, {"ok": False, "error": "request body must be between 1 byte and 32 MiB"})
                return
            body = self.rfile.read(content_length)
            headers["Content-Type"] = self.headers.get("Content-Type", "application/json; charset=utf-8")
        try:
            status, response_headers, response_body = knee42_request(
                self.command, upstream, body=body, headers=headers
            )
        except (OSError, TimeoutError) as error:
            self.send_json(503, {"ok": False, "error": "辨識服務未啟動", "detail": str(error)})
            return
        self.send_response(status)
        content_type = next(
            (value for key, value in response_headers if key.lower() == "content-type"),
            "application/json; charset=utf-8",
        )
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response_body)

    def do_GET(self) -> None:
        request_path = urlsplit(self.path).path
        if request_path.startswith("/knee42/"):
            self.serve_knee42(request_path)
            return
        if request_path == "/clip":
            self.serve_clip_query()
            return
        if request_path != "/health":
            if not is_public_static_path(self.path):
                self.send_json(404, {"error": "not found"})
                return
            self.serve_static()
            return
        try:
            status, _headers, raw = model_request("GET", "/health", timeout=5)
            model_data = json.loads(raw.decode("utf-8"))
            process_alive = model_is_alive()
            correct_model = model_data.get("model") == EXPECTED_MODEL
            healthy = (
                status == 200
                and model_data.get("status") == "ok"
                and process_alive
                and correct_model
                and not MODEL_RESTART_EXHAUSTED
            )
            payload = {
                "status": "ok" if healthy else "error",
                "frontend": "ok",
                "model": model_data.get("model", EXPECTED_MODEL),
                "adapter": "model_service/checkpoint",
                "model_process_alive": process_alive,
                "model_port": MODEL_PORT,
                "model_identity_ok": correct_model,
                "model_restart_count": MODEL_RESTART_COUNT,
                "model_restart_exhausted": MODEL_RESTART_EXHAUSTED,
            }
            self.send_json(200 if healthy else 503, payload)
        except (OSError, TimeoutError, ValueError, json.JSONDecodeError) as error:
            self.send_json(
                503,
                {
                    "status": "starting" if model_is_alive() else "error",
                    "frontend": "ok",
                    "model": EXPECTED_MODEL,
                    "adapter": "model_service/checkpoint",
                    "model_process_alive": model_is_alive(),
                    "model_port": MODEL_PORT,
                    "model_restart_count": MODEL_RESTART_COUNT,
                    "model_restart_exhausted": MODEL_RESTART_EXHAUSTED,
                    "error": str(error),
                },
            )

    def do_HEAD(self) -> None:
        if not is_public_static_path(self.path):
            self.send_json(404, {"error": "not found"})
            return
        self.serve_static()

    def client_key(self) -> str:
        # 經 Pages proxy 進來時，TCP 對端是 cloudflared，真正的來源由 proxy 帶在
        # X-Tsl-Client。這個標頭直打 tunnel 的人可以偽造，所以它只用來分攤
        # 「每人每分鐘」；全站每日上限不看它，偽造也繞不過去。
        for header in ("X-Tsl-Client", "CF-Connecting-IP"):
            value = self.headers.get(header, "").strip()
            if value:
                return value[:64]
        return self.client_address[0]

    def serve_transcribe(self) -> None:
        if not os.environ.get("GEMINI_API_KEY", "").strip():
            self.send_json(503, {"error": "語音輸入尚未啟用（主機沒有設定 GEMINI_API_KEY），請先改用打字輸入。"})
            return
        mime = self.headers.get("Content-Type", "").split(";", 1)[0].strip().lower()
        mime = TRANSCRIBE_MIME_ALIASES.get(mime, mime)
        if mime not in TRANSCRIBE_MIME_TYPES:
            self.send_json(415, {"error": f"unsupported audio type: {mime or '(none)'}"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid Content-Length"})
            return
        if content_length <= 0 or content_length > TRANSCRIBE_MAX_BODY:
            self.send_json(400, {"error": "錄音太長或是空的，請說一句話（15 秒內）。"})
            return
        audio = self.rfile.read(content_length)
        refused = TRANSCRIBE_LIMITER.allow(self.client_key())
        if refused:
            self.send_json(429, {"error": refused})
            return
        try:
            result = transcribe(audio, mime)
        except TranscribeError as error:
            print(f"[0813] transcribe failed: {error}", flush=True)
            self.send_json(502, {"error": "語音辨識服務暫時無法使用，請改用打字輸入。"})
            return
        self.send_json(200, result)

    def do_POST(self) -> None:
        route = self.path.split("?", 1)[0]
        if route.startswith("/knee42/"):
            self.serve_knee42(route)
            return
        if route == "/transcribe":
            self.serve_transcribe()
            return
        if route not in {"/translate", "/clips"}:
            self.send_json(404, {"error": "not found"})
            return
        try:
            content_length = int(self.headers.get("Content-Length", "0"))
        except ValueError:
            self.send_json(400, {"error": "invalid Content-Length"})
            return
        if content_length <= 0 or content_length > 1_048_576:
            self.send_json(400, {"error": "request body must be between 1 byte and 1 MiB"})
            return
        body = self.rfile.read(content_length)
        if route == "/clips":
            self.serve_clip_batch(body)
            return
        try:
            request_data = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            self.send_json(400, {"error": "request body must be UTF-8 JSON"})
            return
        if not isinstance(request_data, dict) or not isinstance(request_data.get("text"), str):
            self.send_json(400, {"error": "text must be a string"})
            return
        text = request_data["text"].strip()
        if not text:
            self.send_json(400, {"error": "text is required"})
            return
        if len(text) > 500:
            self.send_json(400, {"error": "text must not exceed 500 characters"})
            return
        context = request_data.get("context", "")
        if not isinstance(context, str):
            self.send_json(400, {"error": "context must be a string"})
            return
        if len(context.strip()) > 1000:
            self.send_json(400, {"error": "context must not exceed 1000 characters"})
            return
        cache_key = (text, context.strip())
        cached = cached_translation(cache_key)
        if cached is not None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json; charset=utf-8")
            self.send_header("Content-Length", str(len(cached)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            self.wfile.write(cached)
            return
        try:
            with INFERENCE_LOCK:
                status, response_headers, response_body = model_request(
                    "POST",
                    "/translate",
                    body=body,
                    headers={"Content-Type": "application/json; charset=utf-8"},
                    timeout=120,
                )
        except (OSError, TimeoutError) as error:
            self.send_json(503, {"error": "v11 model unavailable", "detail": str(error)})
            return
        if status == 200:
            remember_translation(cache_key, response_body)
        self.send_response(status)
        content_type = next(
            (value for key, value in response_headers if key.lower() == "content-type"),
            "application/json; charset=utf-8",
        )
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(response_body)))
        self.send_header("Cache-Control", "no-store")
        self.end_headers()
        self.wfile.write(response_body)


def main() -> None:
    global MODEL_PORT
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default=os.environ.get("HOST", "127.0.0.1"))
    parser.add_argument("--port", type=int, default=int(os.environ.get("PORT", "8083")))
    parser.add_argument(
        "--model-port", type=int, default=int(os.environ.get("MODEL_PORT", "8877"))
    )
    args = parser.parse_args()
    MODEL_PORT = args.model_port
    if args.host not in {"127.0.0.1", "localhost", "::1"}:
        parser.error("0813 only supports a loopback host; use an SSH tunnel")
    LOG_DIR.mkdir(parents=True, exist_ok=True)
    server = ThreadingHTTPServer((args.host, args.port), Handler)

    def stop_on_signal(_signum: int, _frame: Any) -> None:
        raise KeyboardInterrupt

    signal.signal(signal.SIGTERM, stop_on_signal)
    signal.signal(signal.SIGINT, stop_on_signal)
    try:
        start_model()
        threading.Thread(target=supervise_model, daemon=True).start()
        print(f"[0813] Open http://{args.host}:{args.port}/", flush=True)
        server.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        STOP_EVENT.set()
        server.server_close()
        stop_model()


if __name__ == "__main__":
    main()
