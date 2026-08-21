"""The clip endpoints: the reason a sentence now waits half a second, not six.

A lexicon entry is a fraction of a second out of a recording that runs for
minutes, and the recordings run to 80 MB. Serving the slice instead of the
file is what made playback quick, so what is checked here is that the slice
really is a slice — same frames, same range, no neighbours — and that the
cache it writes stays private.
"""

import gzip
import http.client
from http.server import ThreadingHTTPServer
import importlib.util
import json
from pathlib import Path
import shutil
import tempfile
import threading
import unittest


ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = ROOT / "bundle_server.py"


def load_bundle_server():
    spec = importlib.util.spec_from_file_location("bundle_server_clips", MODULE_PATH)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


RECORDING = {
    "version": 2,
    "label": "fixture",
    "fps": 30.0,
    "source_width": 1920,
    "source_height": 1080,
    "created_at": "2026-08-18T00:00:00+00:00",
    "frames": [
        {"index": i, "timestamp": round(i / 10, 3), "hands": [], "pose": None}
        for i in range(60)
    ],
}


class ClipEndpointTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.bundle = load_bundle_server()
        # a throwaway cache, so a test run never touches the real 1.6 GB one
        cls.cache = Path(tempfile.mkdtemp(prefix="clip-cache-test-"))
        cls.bundle.CLIP_CACHE = cls.cache
        cls.recording_name = "test_clip_fixture.json"
        cls.recording = ROOT / "recordings" / cls.recording_name
        cls.recording.parent.mkdir(parents=True, exist_ok=True)
        cls.recording.write_text(json.dumps(RECORDING), encoding="utf-8")

    @classmethod
    def tearDownClass(cls):
        shutil.rmtree(cls.cache, ignore_errors=True)
        cls.recording.unlink(missing_ok=True)

    def call(self, method, path, payload=None, accept_gzip=True):
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.bundle.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
            body = None if payload is None else json.dumps(payload).encode("utf-8")
            headers = {"Accept-Encoding": "gzip" if accept_gzip else "identity"}
            if body is not None:
                headers["Content-Type"] = "application/json"
            connection.request(method, path, body=body, headers=headers)
            response = connection.getresponse()
            raw = response.read()
            encoding = response.getheader("Content-Encoding")
            connection.close()
            if encoding == "gzip":
                raw = gzip.decompress(raw)
            return response.status, raw
        finally:
            server.shutdown()
            server.server_close()

    def test_clip_returns_only_the_requested_range(self):
        status, raw = self.call("GET", f"/clip?name={self.recording_name}&start=1.0&end=2.0")
        self.assertEqual(status, 200)
        clip = json.loads(raw)
        stamps = [frame["timestamp"] for frame in clip["frames"]]
        self.assertEqual(stamps, [round(i / 10, 3) for i in range(10, 21)])
        # the recording's own metadata travels with the slice, because the
        # composer reads version and source size off it
        self.assertEqual(clip["version"], RECORDING["version"])
        self.assertEqual(clip["source_width"], RECORDING["source_width"])
        self.assertEqual((clip["start"], clip["end"]), (1.0, 2.0))

    def test_clip_is_a_fraction_of_the_recording(self):
        status, raw = self.call("GET", f"/clip?name={self.recording_name}&start=0&end=0.2")
        self.assertEqual(status, 200)
        self.assertLess(len(raw), self.recording.stat().st_size / 4)

    def test_batch_answers_in_order_and_names_what_is_missing(self):
        status, raw = self.call("POST", "/clips", {"items": [
            {"name": self.recording_name, "start": 0.0, "end": 0.2},
            {"name": "no_such_recording.json", "start": 0.0, "end": 1.0},
            {"name": self.recording_name, "start": 5.0, "end": 5.2},
        ]})
        self.assertEqual(status, 200)
        payload = json.loads(raw)
        self.assertEqual(len(payload["clips"]), 3)
        self.assertEqual(len(payload["clips"][0]["frames"]), 3)
        self.assertIsNone(payload["clips"][1])
        self.assertEqual(payload["missing"], ["no_such_recording.json"])
        self.assertEqual(len(payload["clips"][2]["frames"]), 3)

    def test_second_request_is_served_from_the_cache(self):
        query = f"/clip?name={self.recording_name}&start=3.0&end=3.4"
        cached = self.bundle.clip_cache_path(self.recording_name, 3.0, 3.4)
        self.assertFalse(cached.is_file())
        first = self.call("GET", query)
        self.assertTrue(cached.is_file())
        second = self.call("GET", query)
        self.assertEqual(first, second)

    def test_a_clip_request_cannot_escape_the_recordings_directory(self):
        for name in ["../bundle_server.py", "..%2Fbundle_server.py", "sub/dir.json", ".hidden.json"]:
            with self.subTest(name=name):
                status, _raw = self.call("GET", f"/clip?name={name}&start=0&end=1")
                self.assertEqual(status, 404)

    def test_bad_requests_are_rejected(self):
        cases = [
            ("GET", f"/clip?name={self.recording_name}", None),
            ("GET", f"/clip?name={self.recording_name}&start=x&end=1", None),
            ("POST", "/clips", {"items": []}),
            ("POST", "/clips", {"items": [{"name": self.recording_name, "start": 2, "end": 1}]}),
            ("POST", "/clips", {"items": [{"name": self.recording_name, "start": "0", "end": 1}]}),
        ]
        for method, path, payload in cases:
            with self.subTest(path=path, payload=payload):
                status, _raw = self.call(method, path, payload)
                self.assertEqual(status, 400)

    def test_batch_size_is_bounded(self):
        item = {"name": self.recording_name, "start": 0, "end": 0.1}
        oversized = [item] * (self.bundle.CLIP_MAX_BATCH + 1)
        status, _raw = self.call("POST", "/clips", {"items": oversized})
        self.assertEqual(status, 400)

    def test_the_clip_cache_is_not_served_to_the_public(self):
        self.assertFalse(self.bundle.is_public_static_path("/clip_cache/aa/bb.json.gz"))
        self.assertFalse(self.bundle.is_public_static_path("/prewarm_clips.py"))

    def test_text_assets_are_compressed_for_clients_that_ask(self):
        server = ThreadingHTTPServer(("127.0.0.1", 0), self.bundle.Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            connection = http.client.HTTPConnection("127.0.0.1", server.server_address[1], timeout=10)
            connection.request("GET", "/style.css", headers={"Accept-Encoding": "gzip"})
            response = connection.getresponse()
            body = response.read()
            self.assertEqual(response.status, 200)
            self.assertEqual(response.getheader("Content-Encoding"), "gzip")
            self.assertEqual(response.getheader("Vary"), "Accept-Encoding")
            self.assertLess(len(body), (ROOT / "style.css").stat().st_size)
            self.assertIn(b".timeline-track", gzip.decompress(body))
        finally:
            server.shutdown()
            server.server_close()


if __name__ == "__main__":
    unittest.main()
