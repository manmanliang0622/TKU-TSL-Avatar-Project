"""The `signavatar view` server: serves viewer.html and the recording JSON."""

import json
import threading
import urllib.error
import urllib.request

import pytest

from signavatar.schema import Frame, Recording, save_recording
from signavatar.viewer import make_server


@pytest.fixture
def recording_file(tmp_path):
    rec = Recording(
        fps=30.0,
        source_width=640,
        source_height=480,
        created_at="2026-07-04T00:00:00+00:00",
        label="test",
        frames=[Frame(index=0, timestamp=0.0, hands=[])],
    )
    path = tmp_path / "rec.json"
    save_recording(rec, path)
    return path


@pytest.fixture
def server(recording_file):
    srv = make_server(recording_file)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def get(url):
    with urllib.request.urlopen(url, timeout=5) as res:
        return res.status, res.headers.get_content_type(), res.read()


def test_serves_recording_json(server, recording_file):
    status, ctype, body = get(f"{server}/recording.json")
    assert status == 200
    assert ctype == "application/json"
    assert json.loads(body) == json.loads(recording_file.read_text())


def test_viewer_page_served(server):
    status, ctype, body = get(f"{server}/viewer.html")
    assert status == 200
    assert ctype == "text/html"
    assert b"SignAvatar" in body


def test_missing_recording_rejected(tmp_path):
    with pytest.raises(FileNotFoundError):
        make_server(tmp_path / "nope.json")


def test_video_404_when_not_configured(server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(f"{server}/video")
    assert exc.value.code == 404


def test_serves_video_when_configured(recording_file, tmp_path):
    video = tmp_path / "clip.webm"
    video.write_bytes(b"\x1aE\xdf\xa3fake-webm")
    srv = make_server(recording_file, video_path=video)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    try:
        status, ctype, body = get(f"http://127.0.0.1:{srv.server_address[1]}/video")
        assert status == 200
        assert ctype == "video/webm"
        assert body == video.read_bytes()
    finally:
        srv.shutdown()
        srv.server_close()


def test_missing_video_rejected(recording_file, tmp_path):
    with pytest.raises(FileNotFoundError):
        make_server(recording_file, video_path=tmp_path / "nope.webm")


def test_status_and_models(server, recording_file):
    status, _, body = get(f"{server}/status")
    assert status == 200
    assert json.loads(body)["recording"] == recording_file.name
    status, _, body = get(f"{server}/models.json")
    assert status == 200
    assert isinstance(json.loads(body)["models"], list)


def test_recordings_route_serves_only_json_in_dir(server, recording_file):
    status, _, body = get(f"{server}/recordings/{recording_file.name}")
    assert status == 200
    assert json.loads(body) == json.loads(recording_file.read_text())
    with pytest.raises(urllib.error.HTTPError) as exc:
        get(f"{server}/recordings/nope.json")
    assert exc.value.code == 404
    with pytest.raises(urllib.error.HTTPError) as exc:  # traversal is confined to basename
        get(f"{server}/recordings/..%2F..%2Fetc%2Fpasswd.json")
    assert exc.value.code == 404


def test_library_lists_recordings(server, recording_file):
    status, _, body = get(f"{server}/library")
    assert status == 200
    recs = json.loads(body)["recordings"]
    assert [r["name"] for r in recs] == [recording_file.name]
    assert recs[0]["label"] == "test"
    assert recs[0]["frames"] == 1
    assert recs[0]["video"] is None


def test_videos_route_serves_sibling_video(recording_file, tmp_path):
    (tmp_path / "rec.webm").write_bytes(b"\x1aE\xdf\xa3fake")
    srv = make_server(recording_file)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        _, _, body = get(f"{base}/library")
        assert json.loads(body)["recordings"][0]["video"] == "videos/rec.webm"
        status, ctype, _ = get(f"{base}/videos/rec.webm")
        assert status == 200 and ctype == "video/webm"
        with pytest.raises(urllib.error.HTTPError) as exc:
            get(f"{base}/videos/nope.mp4")
        assert exc.value.code == 404
    finally:
        srv.shutdown()
        srv.server_close()


def test_root_serves_landing(server):
    status, ctype, body = get(f"{server}/")
    assert status == 200
    assert ctype == "text/html"
    assert "內建" in body.decode() or b"library" in body.lower()


def test_lexicon_roundtrip(server, recording_file):
    status, _, body = get(f"{server}/lexicon")
    assert status == 200 and json.loads(body) == {}

    entry = json.dumps(
        {"name": "財神", "recording": recording_file.name, "start": 1.0, "end": 2.5}
    ).encode()
    req = urllib.request.Request(f"{server}/lexicon", data=entry)
    with urllib.request.urlopen(req, timeout=5) as res:
        assert res.status == 200

    _, _, body = get(f"{server}/lexicon")
    lex = json.loads(body)
    assert lex["財神"] == {"recording": recording_file.name, "start": 1.0, "end": 2.5}

    bad = json.dumps({"name": "x", "recording": "r.json", "start": 3, "end": 1}).encode()
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(urllib.request.Request(f"{server}/lexicon", data=bad), timeout=5)
    assert exc.value.code == 400

    delete = json.dumps({"name": "財神", "delete": True}).encode()
    urllib.request.urlopen(urllib.request.Request(f"{server}/lexicon", data=delete), timeout=5)
    _, _, body = get(f"{server}/lexicon")
    assert json.loads(body) == {}


def test_upload_accepts_percent_encoded_chinese_filename(recording_file, tmp_path):
    """Header values are ISO-8859-1 only; the client percent-encodes names."""
    import time
    from urllib.parse import quote

    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")

    video = tmp_path / "src.avi"
    writer = cv2.VideoWriter(str(video), cv2.VideoWriter_fourcc(*"MJPG"), 10.0, (64, 48))
    rng = np.random.default_rng(0)
    for _ in range(3):
        writer.write(rng.integers(0, 255, (48, 64, 3), dtype=np.uint8))
    writer.release()

    srv = make_server(recording_file)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        req = urllib.request.Request(
            f"{base}/upload",
            data=video.read_bytes(),
            headers={"X-Filename": quote("財神測試.avi")},
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            assert res.status == 202
            assert json.loads(res.read())["name"] == "財神測試.avi"
        deadline = time.time() + 120
        while time.time() < deadline:
            _, _, body = get(f"{base}/extract/status")
            if json.loads(body)["state"] in ("done", "error"):
                break
            time.sleep(0.3)
        assert json.loads(body)["state"] == "done"
        assert (recording_file.parent / "財神測試.json").is_file()
    finally:
        srv.shutdown()
        srv.server_close()


def test_upload_rejects_bad_type(server):
    req = urllib.request.Request(
        f"{server}/upload", data=b"not a video", headers={"X-Filename": "evil.txt"}
    )
    with pytest.raises(urllib.error.HTTPError) as exc:
        urllib.request.urlopen(req, timeout=5)
    assert exc.value.code == 415


def test_upload_extracts_and_switches_recording(recording_file, tmp_path):
    """Upload a real (synthetic) video and wait for extraction to finish."""
    import time

    cv2 = pytest.importorskip("cv2")
    np = pytest.importorskip("numpy")

    video_bytes_path = tmp_path / "src.avi"
    writer = cv2.VideoWriter(str(video_bytes_path), cv2.VideoWriter_fourcc(*"MJPG"), 10.0, (64, 48))
    rng = np.random.default_rng(0)
    for _ in range(5):
        writer.write(rng.integers(0, 255, (48, 64, 3), dtype=np.uint8))
    writer.release()

    srv = make_server(recording_file)
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    base = f"http://127.0.0.1:{srv.server_address[1]}"
    try:
        req = urllib.request.Request(
            f"{base}/upload",
            data=video_bytes_path.read_bytes(),
            headers={"X-Filename": "clip.avi"},
        )
        with urllib.request.urlopen(req, timeout=5) as res:
            assert res.status == 202

        deadline = time.time() + 120
        while time.time() < deadline:
            _, _, body = get(f"{base}/extract/status")
            state = json.loads(body)
            if state["state"] in ("done", "error"):
                break
            time.sleep(0.3)
        assert state["state"] == "done", state
        assert state["frames"] == 5

        _, _, body = get(f"{base}/recording.json")
        rec = json.loads(body)
        assert rec["label"] == "clip"
        assert len(rec["frames"]) == 5
        assert (recording_file.parent / "clip.avi").exists()

        status, ctype, _ = get(f"{base}/video")
        assert status == 200 and ctype == "video/x-msvideo"
    finally:
        srv.shutdown()
        srv.server_close()


def post(url, payload):
    req = urllib.request.Request(
        url, data=json.dumps(payload).encode(), headers={"Content-Type": "application/json"}
    )
    with urllib.request.urlopen(req, timeout=5) as res:
        return res.status, json.loads(res.read())


@pytest.fixture
def translate_server(recording_file, tmp_path):
    (tmp_path / "lexicon.json").write_text(
        json.dumps({"我": {"start": 0}, "聽": {"start": 1}, "沒辦法": {"start": 2}}),
        encoding="utf-8",
    )
    srv = make_server(recording_file)
    srv.RequestHandlerClass.llm_runner = staticmethod(
        lambda prompt: json.dumps(
            {"glosses": ["我", "聽", "沒辦法"], "question": "none", "negation": True}
        )
    )
    thread = threading.Thread(target=srv.serve_forever, daemon=True)
    thread.start()
    yield f"http://127.0.0.1:{srv.server_address[1]}"
    srv.shutdown()
    srv.server_close()


def test_translate_route_uses_llm(translate_server):
    status, body = post(f"{translate_server}/translate", {"text": "我聽不到"})
    assert status == 200
    assert body["glosses"] == ["我", "聽", "沒辦法"]
    assert body["source"] == "llm"
    assert body["negation"] is True


def test_translate_route_llm_off_falls_to_rules(translate_server):
    status, body = post(f"{translate_server}/translate", {"text": "我無法聽", "llm": False})
    assert status == 200
    assert body["source"] == "rules"
    assert body["glosses"] == ["我", "聽", "沒辦法"]


def test_translate_route_empty_text_400(translate_server):
    with pytest.raises(urllib.error.HTTPError) as exc:
        post(f"{translate_server}/translate", {"text": "  "})
    assert exc.value.code == 400
