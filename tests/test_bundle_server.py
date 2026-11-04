import base64
import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
import os
from pathlib import Path
import shutil
import ssl
import subprocess
import tempfile
import threading
import time
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "bundle_server.py"


class BundleServerPresenceTests(unittest.TestCase):
    def test_bundle_server_exists(self):
        self.assertTrue(MODULE_PATH.is_file(), "bundle_server.py must exist")


def load_bundle_server():
    spec = importlib.util.spec_from_file_location("bundle_server_under_test", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


class FakeModelHandler(BaseHTTPRequestHandler):
    model_name = ""  # 每個測試的 setUp 換成 bundle_server 的 EXPECTED_MODEL
    delay_seconds = 0
    active_requests = 0
    max_active_requests = 0
    total_requests = 0
    counter_lock = threading.Lock()

    def log_message(self, *_args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {
                "status": "ok",
                "adapter": "model_service/checkpoint",
                "model": type(self).model_name,
                "target": "json",
            })
        else:
            self._json(404, {"error": "not found"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        if self.path == "/translate":
            with type(self).counter_lock:
                type(self).active_requests += 1
                type(self).total_requests += 1
                type(self).max_active_requests = max(
                    type(self).max_active_requests, type(self).active_requests
                )
            try:
                time.sleep(type(self).delay_seconds)
                self._json(200, {
                    "chinese": request["text"],
                    "gloss": ["我", "水", "喝", "要"],
                    "gloss_text": "我/水/喝/要",
                    "model": type(self).model_name,
                })
            finally:
                with type(self).counter_lock:
                    type(self).active_requests -= 1
        else:
            self._json(404, {"error": "not found"})


class FakeRecognizerHandler(BaseHTTPRequestHandler):
    """扮演 Knee42 webservice：永遠走 TLS（自簽），回應形狀照它的 API。"""

    def log_message(self, *_args):
        pass

    def _json(self, status, payload):
        body = json.dumps(payload).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        if self.path == "/health":
            self._json(200, {"ok": True, "model": "knee42_transformer", "classes": 42})
        elif self.path == "/labels":
            self._json(200, {"ok": True, "labels": [{"label": "K42_01", "text": "你好"}]})
        else:
            self._json(404, {"ok": False, "message": "no such route"})

    def do_POST(self):
        length = int(self.headers.get("Content-Length", "0"))
        request = json.loads(self.rfile.read(length))
        if self.path == "/predict":
            self._json(200, {
                "ok": True,
                "n_frames": len(request.get("frames", [])),
                "whole": {"top": [{"label": "K42_14", "text": "我要喝水", "prob": 0.91}]},
                "segments": [],
            })
        elif self.path == "/stream":
            self._json(200, {
                "ok": True,
                "session": request.get("session", ""),
                "state": "IDLE_BLANK",
                "calibrated": True,
                "buffered": 0,
                "results": [],
            })
        else:
            self._json(404, {"ok": False, "message": "no such route"})


def self_signed_certificate(directory):
    """openssl 一次性自簽憑證；沒有 openssl 的環境跳過相關測試。"""
    certfile = Path(directory) / "server.crt"
    keyfile = Path(directory) / "server.key"
    subprocess.run(
        [
            "openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1",
            "-subj", "/CN=localhost",
            "-keyout", str(keyfile), "-out", str(certfile),
        ],
        check=True,
        capture_output=True,
    )
    return certfile, keyfile


class BundleServerBehaviorTests(unittest.TestCase):
    class AliveProcess:
        def poll(self):
            return None

    class DeadProcess:
        def poll(self):
            return 1

    def setUp(self):
        self.bundle = load_bundle_server()
        self.bundle.MODEL_PROC = self.AliveProcess()
        # 線上模型會被無預告換版（同一天 v19 → v21），版本號跟著 bundle_server
        # 的 EXPECTED_MODEL 走；寫死在這裡只會讓每次換版都誤報成壞掉
        FakeModelHandler.model_name = self.bundle.EXPECTED_MODEL
        FakeModelHandler.delay_seconds = 0
        FakeModelHandler.active_requests = 0
        FakeModelHandler.max_active_requests = 0
        FakeModelHandler.total_requests = 0

    def request(self, method, path, payload=None):
        self.assertTrue(hasattr(self.bundle, "Handler"), "Handler must exist")
        model_server = ThreadingHTTPServer(("127.0.0.1", 0), FakeModelHandler)
        model_thread = threading.Thread(target=model_server.serve_forever, daemon=True)
        model_thread.start()
        self.bundle.MODEL_PORT = model_server.server_address[1]
        frontend_server = ThreadingHTTPServer(("127.0.0.1", 0), self.bundle.Handler)
        frontend_thread = threading.Thread(target=frontend_server.serve_forever, daemon=True)
        frontend_thread.start()
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", frontend_server.server_address[1], timeout=5
            )
            body = None if payload is None else json.dumps(payload).encode("utf-8")
            headers = {} if body is None else {"Content-Type": "application/json"}
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = json.loads(response.read())
            connection.close()
            return response.status, data
        finally:
            frontend_server.shutdown()
            frontend_server.server_close()
            model_server.shutdown()
            model_server.server_close()

    def static_status(self, method, path):
        self.assertTrue(hasattr(self.bundle, "Handler"), "Handler must exist")
        frontend_server = ThreadingHTTPServer(("127.0.0.1", 0), self.bundle.Handler)
        frontend_thread = threading.Thread(target=frontend_server.serve_forever, daemon=True)
        frontend_thread.start()
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", frontend_server.server_address[1], timeout=5
            )
            connection.request(method, path)
            response = connection.getresponse()
            response.read()
            connection.close()
            return response.status
        finally:
            frontend_server.shutdown()
            frontend_server.server_close()

    def test_model_command_uses_only_0813_artifacts(self):
        self.assertTrue(hasattr(self.bundle, "model_cmd"), "model_cmd must exist")
        command = self.bundle.model_cmd(8877)
        joined = " ".join(command)
        self.assertEqual(command[0], str(ROOT / ".venv/bin/python3"))
        self.assertIn(str(ROOT / "model_service/base_model"), command)
        self.assertIn(str(ROOT / "model_service/checkpoint"), command)
        self.assertIn(str(ROOT / "model_service/scripts/serve_model.py"), command)
        # 0821 服務的是腳本格式（tsl-script-v1）：輸出 sign_ids 陣列＋oov_items，
        # 比舊 JSON 長，--max-new 沿用預設 64 會把輸出截斷
        self.assertEqual(command[command.index("--target") + 1], "script")
        self.assertEqual(command[command.index("--max-new") + 1], "256")
        self.assertEqual(command[command.index("--model-name") + 1], self.bundle.EXPECTED_MODEL)
        self.assertIn("8877", command)
        self.assertNotIn("/home/b310ai/0812", joined)
        self.assertNotIn("tku-tsl-text-to-gloss", joined)
        self.assertNotIn(".cache/huggingface", joined)

    def test_health_reports_expected_model(self):
        status, data = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["frontend"], "ok")
        self.assertEqual(data["model"], self.bundle.EXPECTED_MODEL)

    def test_health_rejects_wrong_model_identity(self):
        FakeModelHandler.model_name = "qlora_e4b_v12_context"
        status, data = self.request("GET", "/health")
        self.assertEqual(status, 503)
        self.assertEqual(data["status"], "error")

    def test_health_rejects_dead_owned_model_process(self):
        self.bundle.MODEL_PROC = self.DeadProcess()
        status, data = self.request("GET", "/health")
        self.assertEqual(status, 503)
        self.assertFalse(data["model_process_alive"])

    def test_translate_proxies_model_json(self):
        status, data = self.request("POST", "/translate", {"text": "我要喝水"})
        self.assertEqual(status, 200)
        self.assertEqual(data["chinese"], "我要喝水")
        self.assertEqual(data["gloss"], ["我", "水", "喝", "要"])
        self.assertEqual(data["model"], self.bundle.EXPECTED_MODEL)

    def test_translate_rejects_non_string_and_long_text(self):
        status, data = self.request("POST", "/translate", {"text": {"bad": "type"}})
        self.assertEqual(status, 400)
        self.assertIn("string", data["error"])
        status, data = self.request("POST", "/translate", {"text": "字" * 501})
        self.assertEqual(status, 400)
        self.assertIn("500", data["error"])

    def test_translate_validates_optional_context(self):
        status, data = self.request(
            "POST", "/translate", {"text": "我要喝水", "context": {"bad": "type"}}
        )
        self.assertEqual(status, 400)
        self.assertIn("context", data["error"])
        status, data = self.request(
            "POST", "/translate", {"text": "我要喝水", "context": "前" * 1001}
        )
        self.assertEqual(status, 400)
        self.assertIn("1000", data["error"])

    def test_translate_requests_are_serialized(self):
        FakeModelHandler.delay_seconds = 0.2
        results = []

        def translate():
            results.append(self.request("POST", "/translate", {"text": "我要喝水"}))

        first = threading.Thread(target=translate)
        second = threading.Thread(target=translate)
        first.start()
        second.start()
        first.join(timeout=5)
        second.join(timeout=5)
        self.assertEqual([status for status, _data in results], [200, 200])
        self.assertEqual(FakeModelHandler.max_active_requests, 1)

    def test_a_repeated_sentence_is_answered_without_the_model(self):
        """Generation is greedy, so the same sentence has exactly one answer.

        Four seconds of it, every time, is the single longest wait in the
        product — and a demo says the same sentence over and over.
        """
        first_status, first = self.request("POST", "/translate", {"text": "我要喝水"})
        second_status, second = self.request("POST", "/translate", {"text": "我要喝水"})
        self.assertEqual((first_status, second_status), (200, 200))
        self.assertEqual(first, second)
        self.assertEqual(FakeModelHandler.total_requests, 1)

    def test_a_different_context_is_a_different_answer(self):
        """v12 conditions on the previous sentence, so context is part of the
        key — sharing one entry across contexts would serve the wrong gloss."""
        self.request("POST", "/translate", {"text": "他呢", "context": "我去學校"})
        self.request("POST", "/translate", {"text": "他呢", "context": "我吃飯了"})
        self.assertEqual(FakeModelHandler.total_requests, 2)

    def test_a_failed_translation_is_not_remembered(self):
        status, _data = self.request("POST", "/translate", {"text": ""})
        self.assertEqual(status, 400)
        self.assertEqual(FakeModelHandler.total_requests, 0)

    def test_sensitive_project_files_are_not_served(self):
        sensitive_paths = [
            "/.git/config",
            "/%2egit/config",
            "/.venv/pyvenv.cfg",
            "/model_service/base_model/config.json",
            "/logs/bundle-server.log",
            "/tests/test_bundle_server.py",
            "/bundle_server.py",
            "/start_0813.sh",
        ]
        for path in sensitive_paths:
            with self.subTest(path=path):
                self.assertEqual(self.static_status("GET", path), 404)
                self.assertEqual(self.static_status("HEAD", path), 404)

    def test_frontend_assets_remain_public(self):
        for path in ["/", "/style.css", "/script.js", "/models/avatar.vrm"]:
            with self.subTest(path=path):
                self.assertEqual(self.static_status("GET", path), 200)


class RecognizerProxyTests(unittest.TestCase):
    """/knee42/* 只是轉發：白名單、身長上限、服務沒開時的明確 503。

    Knee42 webservice 永遠把 socket 包進自簽 TLS，所以假伺服器也得是 HTTPS，
    bundle_server 那端關驗證（憑證本來就驗不過）才連得上——這裡順便驗證
    這件事真的成立。
    """

    def setUp(self):
        self.bundle = load_bundle_server()

    def request(self, method, path, payload=None, declared_length=None, recognizer_up=True):
        recognizer_server = None
        if recognizer_up:
            if not shutil.which("openssl"):
                self.skipTest("openssl unavailable; cannot fake the TLS recognizer")
            self._tmp = tempfile.TemporaryDirectory()
            self.addCleanup(self._tmp.cleanup)
            certfile, keyfile = self_signed_certificate(self._tmp.name)
            recognizer_server = ThreadingHTTPServer(("127.0.0.1", 0), FakeRecognizerHandler)
            context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
            context.load_cert_chain(certfile=str(certfile), keyfile=str(keyfile))
            recognizer_server.socket = context.wrap_socket(
                recognizer_server.socket, server_side=True
            )
            threading.Thread(target=recognizer_server.serve_forever, daemon=True).start()
            self.bundle.KNEE42_PORT = recognizer_server.server_address[1]
        else:
            # 保證沒人在聽的 port：綁一個再立刻關掉
            probe = ThreadingHTTPServer(("127.0.0.1", 0), FakeRecognizerHandler)
            self.bundle.KNEE42_PORT = probe.server_address[1]
            probe.server_close()

        frontend_server = ThreadingHTTPServer(("127.0.0.1", 0), self.bundle.Handler)
        threading.Thread(target=frontend_server.serve_forever, daemon=True).start()
        try:
            connection = http.client.HTTPConnection(
                "127.0.0.1", frontend_server.server_address[1], timeout=10
            )
            if declared_length is not None:
                # 上限檢查只看 Content-Length 標頭，超標會在讀 body 之前就回 400
                # 並斷線——真送 32 MiB 只會換來 BrokenPipe，宣告長度就夠了
                connection.putrequest(method, path)
                connection.putheader("Content-Type", "application/json")
                connection.putheader("Content-Length", str(declared_length))
                connection.endheaders()
            else:
                body = None if payload is None else json.dumps(payload).encode("utf-8")
                headers = {} if body is None else {"Content-Type": "application/json"}
                connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            data = json.loads(response.read())
            connection.close()
            return response.status, data
        finally:
            frontend_server.shutdown()
            frontend_server.server_close()
            if recognizer_server is not None:
                recognizer_server.shutdown()
                recognizer_server.server_close()

    def test_predict_and_stream_are_forwarded(self):
        status, data = self.request(
            "POST", "/knee42/predict", {"frames": [{"timestamp": 0.0, "hands": []}]}
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["whole"]["top"][0]["text"], "我要喝水")
        status, data = self.request(
            "POST", "/knee42/stream", {"session": "abc", "reset": True, "frames": []}
        )
        self.assertEqual(status, 200)
        self.assertEqual(data["session"], "abc")
        self.assertTrue(data["calibrated"])

    def test_health_and_labels_are_forwarded(self):
        status, data = self.request("GET", "/knee42/health")
        self.assertEqual(status, 200)
        self.assertEqual(data["classes"], 42)
        status, data = self.request("GET", "/knee42/labels")
        self.assertEqual(status, 200)
        self.assertEqual(data["labels"][0]["text"], "你好")

    def test_only_whitelisted_recognizer_routes_exist(self):
        # 辨識服務還有 /analyze_url（會對外抓影片）等端點，不在白名單上的不轉
        for method, path in [
            ("POST", "/knee42/analyze_url"),
            ("POST", "/knee42/analyze_upload"),
            ("GET", "/knee42/job/abc"),
            # 動詞也要對：POST 路徑用 GET 打、GET 路徑用 POST 打都不轉
            ("GET", "/knee42/predict"),
            ("POST", "/knee42/labels"),
        ]:
            with self.subTest(path=path):
                payload = {"url": "https://example.com"} if method == "POST" else None
                status, _data = self.request(method, path, payload)
                self.assertEqual(status, 404)

    def test_recognizer_down_is_a_clear_503(self):
        status, data = self.request(
            "POST", "/knee42/stream", {"session": "x", "frames": []}, recognizer_up=False
        )
        self.assertEqual(status, 503)
        self.assertEqual(data["ok"], False)
        self.assertIn("辨識服務未啟動", data["error"])

    def test_recognize_body_limit_is_wider_but_bounded(self):
        # landmark 幀比 /translate 的一句話大得多，上限放寬到 32 MiB，但仍有上限
        self.assertEqual(self.bundle.KNEE42_MAX_BODY, 32 * 1024 * 1024)
        status, data = self.request(
            "POST",
            "/knee42/predict",
            declared_length=self.bundle.KNEE42_MAX_BODY + 1,
            recognizer_up=False,
        )
        self.assertEqual(status, 400)
        self.assertIn("between 1 byte", data["error"])

    def test_translate_body_limit_is_not_widened(self):
        status, data = self.request(
            "POST", "/translate", declared_length=1_048_577, recognizer_up=False
        )
        self.assertEqual(status, 400)


class TranscribeTests(unittest.TestCase):
    """生成頁的語音輸入：/transcribe 把音訊轉給 Gemini。真的 API 不打，換成假的。"""

    AUDIO = b"\x1a\x45\xdf\xa3fake-webm-opus"

    def setUp(self):
        self.bundle = load_bundle_server()
        self.calls = []
        self.primary = {"steps": [{"type": "model_output", "content": [{"type": "text", "text": "我要去 新竹"}]}]}
        self.fallback = {"candidates": [{"content": {"parts": [{"text": "我要去新竹"}]}}]}

        def fake_post(path, payload):
            self.calls.append((path, payload))
            result = self.primary if path == "interactions" else self.fallback
            if isinstance(result, Exception):
                raise result
            return result

        self.bundle.gemini_post = fake_post
        self.bundle.TO_TRADITIONAL = None
        self.bundle.TRANSCRIBE_LIMITER = self.bundle.TranscribeLimiter(100, 1000)
        self.saved_key = os.environ.get("GEMINI_API_KEY")
        os.environ["GEMINI_API_KEY"] = "test-key"

    def tearDown(self):
        if self.saved_key is None:
            os.environ.pop("GEMINI_API_KEY", None)
        else:
            os.environ["GEMINI_API_KEY"] = self.saved_key

    def post(self, body=AUDIO, content_type="audio/webm;codecs=opus", headers=None, declared_length=None):
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.bundle.Handler)
        threading.Thread(target=server.serve_forever, daemon=True).start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=5)
            connection.putrequest("POST", "/transcribe")
            connection.putheader("Content-Type", content_type)
            connection.putheader("Content-Length", str(len(body) if declared_length is None else declared_length))
            for name, value in (headers or {}).items():
                connection.putheader(name, value)
            connection.endheaders()
            if declared_length is None:
                connection.send(body)
            response = connection.getresponse()
            data = json.loads(response.read())
            connection.close()
            return response.status, data
        finally:
            server.shutdown()
            server.server_close()

    def test_audio_is_sent_to_the_transcribe_model(self):
        status, data = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(data["text"], "我要去 新竹")
        self.assertEqual(data["model"], self.bundle.TRANSCRIBE_MODEL)
        path, payload = self.calls[0]
        self.assertEqual(path, "interactions")
        audio = payload["input"][0]
        self.assertEqual(audio["mime_type"], "audio/webm")  # codecs 參數不往上送
        self.assertEqual(base64.b64decode(audio["data"]), self.AUDIO)
        self.assertEqual(payload["generation_config"]["transcription_config"]["language_codes"], ["cmn-Hans-CN"])

    def test_empty_transcript_falls_back_to_flash_lite(self):
        # Google 論壇回報：gemini-3.5-transcribe 會回 200 但內容全空
        self.primary = {"steps": [{"type": "model_output", "content": []}]}
        status, data = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(data["text"], "我要去新竹")
        self.assertEqual(data["model"], self.bundle.TRANSCRIBE_FALLBACK_MODEL)
        self.assertEqual(self.calls[1][0], f"models/{self.bundle.TRANSCRIBE_FALLBACK_MODEL}:generateContent")

    def test_primary_error_falls_back_and_double_failure_is_502(self):
        self.primary = self.bundle.TranscribeError("interactions HTTP 500")
        status, data = self.post()
        self.assertEqual((status, data["text"]), (200, "我要去新竹"))
        self.fallback = self.bundle.TranscribeError("generateContent HTTP 500")
        status, data = self.post()
        self.assertEqual(status, 502)
        self.assertNotIn("test-key", json.dumps(data))

    def test_result_is_converted_to_taiwan_traditional(self):
        self.primary = {"steps": [{"type": "model_output", "content": [{"type": "text", "text": "我听不到"}]}]}
        self.bundle.TO_TRADITIONAL = lambda text: text.replace("听", "聽")
        status, data = self.post()
        self.assertEqual(status, 200)
        self.assertEqual(data["text"], "我聽不到")
        self.assertTrue(data["traditional"])

    def test_safari_mp4_is_sent_as_m4a(self):
        status, _data = self.post(content_type="audio/mp4")
        self.assertEqual(status, 200)
        self.assertEqual(self.calls[0][1]["input"][0]["mime_type"], "audio/m4a")

    def test_without_api_key_it_is_a_clear_503(self):
        os.environ.pop("GEMINI_API_KEY")
        status, data = self.post()
        self.assertEqual(status, 503)
        self.assertIn("GEMINI_API_KEY", data["error"])
        self.assertEqual(self.calls, [])

    def test_bad_requests_never_reach_gemini(self):
        status, _ = self.post(content_type="application/json")
        self.assertEqual(status, 415)
        status, _ = self.post(body=b"")
        self.assertEqual(status, 400)
        status, _ = self.post(declared_length=self.bundle.TRANSCRIBE_MAX_BODY + 1)
        self.assertEqual(status, 400)
        self.assertEqual(self.calls, [])

    def test_rate_limit_is_per_client_and_reaches_gemini_only_when_allowed(self):
        self.bundle.TRANSCRIBE_LIMITER = self.bundle.TranscribeLimiter(1, 1000)
        self.assertEqual(self.post(headers={"X-Tsl-Client": "1.1.1.1"})[0], 200)
        status, data = self.post(headers={"X-Tsl-Client": "1.1.1.1"})
        self.assertEqual(status, 429)
        self.assertIn("一分鐘", data["error"])
        self.assertEqual(self.post(headers={"X-Tsl-Client": "2.2.2.2"})[0], 200)
        self.assertEqual(len(self.calls), 2)

    def test_limiter_windows(self):
        now = [0.0]
        limiter = self.bundle.TranscribeLimiter(2, 3, clock=lambda: now[0])
        self.assertIsNone(limiter.allow("a"))
        self.assertIsNone(limiter.allow("a"))
        self.assertIn("一分鐘", limiter.allow("a"))
        now[0] = 61
        self.assertIsNone(limiter.allow("a"))
        # 全站每日上限不看來源，換人也一樣擋
        self.assertIn("今天", limiter.allow("b"))
        now[0] = 86_401
        self.assertIsNone(limiter.allow("b"))


if __name__ == "__main__":
    unittest.main()
