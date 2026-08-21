import http.client
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
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
    model_name = "qlora_e4b_v11_holdout"
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
        FakeModelHandler.model_name = "qlora_e4b_v11_holdout"
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
        self.assertIn("--target", command)
        self.assertIn("json", command)
        self.assertIn("--model-name", command)
        self.assertIn("qlora_e4b_v11_holdout", command)
        self.assertIn("8877", command)
        self.assertNotIn("/home/b310ai/0812", joined)
        self.assertNotIn("tku-tsl-text-to-gloss", joined)
        self.assertNotIn(".cache/huggingface", joined)

    def test_health_reports_v11_model(self):
        status, data = self.request("GET", "/health")
        self.assertEqual(status, 200)
        self.assertEqual(data["status"], "ok")
        self.assertEqual(data["frontend"], "ok")
        self.assertEqual(data["model"], "qlora_e4b_v11_holdout")

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
        self.assertEqual(data["model"], "qlora_e4b_v11_holdout")

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
        FakeModelHandler.model_name = "qlora_e4b_v11_holdout"
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


if __name__ == "__main__":
    unittest.main()
