"""Local web viewer for recordings (`signavatar view`).

Serves web/viewer.html plus the chosen recording at /recording.json on
localhost. Also accepts video uploads (POST /upload) and runs the tracking
pipeline on them in a background thread, with progress at /extract/status.
Viewing works without the capture dependencies; uploads need mediapipe.
"""

from __future__ import annotations

import json
import re
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from urllib.parse import unquote

WEB_DIR = Path(__file__).resolve().parent.parent.parent / "web"

_MAX_UPLOAD_BYTES = 500 * 1024 * 1024


_VIDEO_TYPES = {
    ".webm": "video/webm",
    ".mp4": "video/mp4",
    ".mov": "video/quicktime",
    ".avi": "video/x-msvideo",
    ".mkv": "video/x-matroska",
}


class _ViewerHandler(SimpleHTTPRequestHandler):
    recording_path: Path  # set by make_server on the subclass
    video_path: Path | None = None
    upload_dir: Path
    extract_state: dict = {"state": "idle"}
    _extract_lock = threading.Lock()

    def _send_file(self, path: Path, content_type: str) -> None:
        data = path.read_bytes()
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_json(self, obj: dict, status: int = 200) -> None:
        data = json.dumps(obj).encode()
        self.send_response(status)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _lexicon_file(self) -> Path:
        return self.upload_dir / "lexicon.json"

    _library_cache: dict = {}  # name → (mtime, meta) — parsing 8MB JSONs is not free

    def _library(self) -> list[dict]:
        cls = type(self)
        entries = []
        for path in self.upload_dir.glob("*.json"):
            if path.name == "lexicon.json":
                continue
            mtime = path.stat().st_mtime
            cached = cls._library_cache.get(path.name)
            if not cached or cached[0] != mtime:
                try:
                    data = json.loads(path.read_text(encoding="utf-8"))
                    frames = data.get("frames", [])
                    meta = {
                        "name": path.name,
                        "label": data.get("label") or path.stem,
                        "frames": len(frames),
                        "duration": round(frames[-1]["timestamp"], 2) if frames else 0,
                        "fps": round(data.get("fps", 0), 1),
                    }
                except Exception:
                    continue  # unreadable file: leave it out of the library
                cls._library_cache[path.name] = (mtime, meta)
            meta = dict(cls._library_cache[path.name][1])
            meta["mtime"] = int(mtime)
            meta["video"] = self._video_url_for(path.stem)
            entries.append(meta)
        return sorted(entries, key=lambda e: -e["mtime"])

    def _video_url_for(self, stem: str) -> str | None:
        for ext in _VIDEO_TYPES:
            if (self.upload_dir / f"{stem}{ext}").is_file():
                return f"videos/{stem}{ext}"
        if self.video_path and self.recording_path.stem == stem:
            return f"videos/{self.video_path.name}"
        return None

    def do_GET(self) -> None:  # noqa: N802 (http.server API)
        route = self.path.split("?", 1)[0]
        if route == "/recording.json":
            self._send_file(self.recording_path, "application/json")
            return
        if route == "/video":
            if self.video_path is None:
                self.send_error(404, "no source video configured")
                return
            ctype = _VIDEO_TYPES.get(self.video_path.suffix.lower(), "video/mp4")
            self._send_file(self.video_path, ctype)
            return
        if route == "/extract/status":
            self._send_json(type(self).extract_state)
            return
        if route == "/status":
            self._send_json(
                {
                    "recording": self.recording_path.name,
                    "video": self.video_path.name if self.video_path else None,
                }
            )
            return
        if route == "/models.json":
            models = sorted(p.name for p in (WEB_DIR / "models").glob("*.vrm"))
            self._send_json({"models": models})
            return
        if route == "/lexicon":
            lex = self._lexicon_file()
            data = json.loads(lex.read_text(encoding="utf-8")) if lex.is_file() else {}
            self._send_json(data)
            return
        if route == "/library":
            self._send_json({"recordings": self._library()})
            return
        if route.startswith("/recordings/"):
            name = Path(unquote(route[len("/recordings/") :])).name  # basename only
            path = self.upload_dir / name
            if name.endswith(".json") and path.is_file():
                self._send_file(path, "application/json")
            else:
                self.send_error(404)
            return
        if route.startswith("/videos/"):
            name = Path(unquote(route[len("/videos/") :])).name  # basename only
            ctype = _VIDEO_TYPES.get(Path(name).suffix.lower())
            path = self.upload_dir / name
            if self.video_path and name == self.video_path.name:
                path = self.video_path
            if ctype and path.is_file():
                self._send_file(path, ctype)
            else:
                self.send_error(404)
            return
        if self.path in ("", "/"):
            self.path = "/index.html"
        super().do_GET()

    llm_runner = None  # tests inject a fake; None = default claude CLI

    def _post_translate(self) -> None:
        """{"text", "llm": bool?} → Translation dict (glosses always in lexicon)."""
        from signavatar.lexicon import load_pairs  # deferred: keeps viewer import light
        from signavatar.translate import select_examples, translate

        try:
            length = int(self.headers.get("Content-Length") or 0)
            payload = json.loads(self.rfile.read(length))
            text = str(payload.get("text", "")).strip()
            if not text:
                raise ValueError("empty text")
        except Exception as ex:
            self._send_json({"error": str(ex)}, 400)
            return
        lex = self._lexicon_file()
        vocab = set(json.loads(lex.read_text(encoding="utf-8"))) if lex.is_file() else set()
        examples = select_examples(text, load_pairs(self.upload_dir / "tsl_pairs.json"))
        result = translate(
            text,
            vocab,
            use_llm=bool(payload.get("llm", True)),
            runner=type(self).llm_runner,
            examples=examples,
        )
        self._send_json(result.as_dict())

    def do_POST(self) -> None:  # noqa: N802 (http.server API)
        route = self.path.split("?", 1)[0]
        if route == "/lexicon":
            self._post_lexicon()
            return
        if route == "/translate":
            self._post_translate()
            return
        if route != "/upload":
            self.send_error(404)
            return
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            self._send_json({"error": "empty upload"}, 400)
            return
        if length > _MAX_UPLOAD_BYTES:
            self._send_json({"error": "file too large"}, 413)
            return
        raw_name = unquote(self.headers.get("X-Filename") or "upload")  # client percent-encodes
        name = re.sub(r"[^\w.-]", "_", Path(raw_name).name)
        suffix = Path(name).suffix.lower()
        if suffix not in _VIDEO_TYPES:
            self._send_json({"error": f"unsupported video type {suffix!r}"}, 415)
            return

        cls = type(self)
        if not cls._extract_lock.acquire(blocking=False):
            self._send_json({"error": "an extraction is already running"}, 409)
            return
        try:
            dest = cls.upload_dir / name
            n = 1
            while dest.exists():
                dest = cls.upload_dir / f"{Path(name).stem}-{n}{suffix}"
                n += 1
            dest.write_bytes(self.rfile.read(length))
        except Exception as ex:
            cls._extract_lock.release()
            self._send_json({"error": str(ex)}, 500)
            return
        cls.extract_state = {"state": "running", "done": 0, "total": 0, "name": dest.name}
        threading.Thread(target=cls._run_extraction, args=(dest,), daemon=True).start()
        self._send_json({"status": "started", "name": dest.name}, 202)

    _lexicon_lock = threading.Lock()

    def _post_lexicon(self) -> None:
        """Upsert one sign: {name, recording, start, end}. DELETE via {"name", "delete": true}."""
        try:
            length = int(self.headers.get("Content-Length") or 0)
            entry = json.loads(self.rfile.read(length))
            name = str(entry["name"]).strip()
            if not name:
                raise ValueError("empty name")
            with type(self)._lexicon_lock:
                lex_file = self._lexicon_file()
                lex = json.loads(lex_file.read_text(encoding="utf-8")) if lex_file.is_file() else {}
                if entry.get("delete"):
                    lex.pop(name, None)
                else:
                    start, end = float(entry["start"]), float(entry["end"])
                    if end <= start:
                        raise ValueError("end must be after start")
                    lex[name] = {
                        "recording": Path(str(entry["recording"])).name,
                        "start": round(start, 3),
                        "end": round(end, 3),
                    }
                lex_file.write_text(json.dumps(lex, ensure_ascii=False, indent=1), encoding="utf-8")
            self._send_json({"status": "ok", "count": len(lex)})
        except Exception as ex:
            self._send_json({"error": str(ex)}, 400)

    @classmethod
    def _run_extraction(cls, video: Path) -> None:
        """Background thread: track the uploaded video, then switch to the result."""
        try:
            from signavatar.capture.extractor import extract  # deferred: needs mediapipe

            out = video.with_suffix(".json")

            def progress(done: int, total: int) -> None:
                cls.extract_state = {
                    "state": "running",
                    "done": done,
                    "total": total,
                    "name": video.name,
                }

            rec = extract(video, out, label=video.stem, on_progress=progress)
            if rec is None:
                cls.extract_state = {"state": "error", "error": "no frames in video"}
                return
            cls.recording_path = out
            cls.video_path = video
            cls.extract_state = {"state": "done", "frames": len(rec.frames), "name": video.name}
        except Exception as ex:
            cls.extract_state = {"state": "error", "error": str(ex)}
        finally:
            cls._extract_lock.release()

    def log_message(self, *args) -> None:
        pass  # keep the CLI output clean


def make_server(
    recording_path: str | Path,
    port: int = 0,
    video_path: str | Path | None = None,
) -> ThreadingHTTPServer:
    """Build a ready-to-serve HTTP server; port 0 picks a free port."""
    recording = Path(recording_path).resolve()
    if not recording.is_file():
        raise FileNotFoundError(f"recording not found: {recording}")
    video = Path(video_path).resolve() if video_path else None
    if video and not video.is_file():
        raise FileNotFoundError(f"video not found: {video}")

    class Handler(_ViewerHandler):
        # directory= is consumed by SimpleHTTPRequestHandler for static files
        def __init__(self, *args, **kwargs):
            super().__init__(*args, directory=str(WEB_DIR), **kwargs)

    Handler.recording_path = recording
    Handler.video_path = video
    Handler.upload_dir = recording.parent  # uploads live beside the recordings

    return ThreadingHTTPServer(("127.0.0.1", port), Handler)
