#!/usr/bin/env python3
"""Single HTTP entry point for the self-contained 0813 project."""

from __future__ import annotations

import argparse
from collections import OrderedDict
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
import subprocess
import threading
import time
from typing import Any
from urllib.parse import parse_qs, unquote, urlsplit


ROOT = Path(__file__).resolve().parent
LOG_DIR = ROOT / "logs"
MODEL_PORT = 8877
MODEL_PROC: subprocess.Popen[bytes] | None = None
MODEL_LOCK = threading.Lock()
MODEL_LOG = None
MODEL_ERR = None
EXPECTED_MODEL = "qlora_e4b_v11_holdout"
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
        "json",
        "--model-name",
        EXPECTED_MODEL,
        "--port",
        str(model_port),
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
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Headers", "Content-Type")
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.end_headers()

    def do_GET(self) -> None:
        request_path = urlsplit(self.path).path
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

    def do_POST(self) -> None:
        route = self.path.split("?", 1)[0]
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
