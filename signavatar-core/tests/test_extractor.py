"""Extractor plumbing test: runs the real tracker over a synthetic video.

The synthetic frames contain no hands, so this verifies frame iteration,
timestamps, and recording metadata — not detection quality.
"""

import numpy as np
import pytest

cv2 = pytest.importorskip("cv2")

from signavatar.capture.extractor import extract  # noqa: E402
from signavatar.capture.tracker import mirrored_handedness  # noqa: E402
from signavatar.schema import load_recording  # noqa: E402

WIDTH, HEIGHT, FPS, N_FRAMES = 64, 48, 20.0, 10


@pytest.fixture
def synthetic_video(tmp_path):
    path = tmp_path / "clip.avi"
    writer = cv2.VideoWriter(str(path), cv2.VideoWriter_fourcc(*"MJPG"), FPS, (WIDTH, HEIGHT))
    rng = np.random.default_rng(0)
    for _ in range(N_FRAMES):
        writer.write(rng.integers(0, 255, (HEIGHT, WIDTH, 3), dtype=np.uint8))
    writer.release()
    return path


def test_extract_writes_recording(synthetic_video, tmp_path):
    out = tmp_path / "rec.json"
    rec = extract(synthetic_video, out, label="clip")

    assert rec is not None
    assert out.exists()
    assert load_recording(out) == rec

    assert rec.label == "clip"
    assert rec.fps == pytest.approx(FPS)
    assert (rec.source_width, rec.source_height) == (WIDTH, HEIGHT)
    assert len(rec.frames) == N_FRAMES

    timestamps = [f.timestamp for f in rec.frames]
    assert timestamps[0] == 0.0
    assert timestamps == sorted(timestamps)
    assert timestamps[-1] == pytest.approx((N_FRAMES - 1) / FPS)
    assert [f.index for f in rec.frames] == list(range(N_FRAMES))


def test_extract_missing_file(tmp_path):
    with pytest.raises(RuntimeError, match="cannot open"):
        extract(tmp_path / "nope.mp4", tmp_path / "out.json")


def test_mirrored_handedness_swaps_tasks_api_labels():
    """Tasks-API labels assume unmirrored input; flipped frames need the swap."""
    assert mirrored_handedness("Left") == "Right"
    assert mirrored_handedness("Right") == "Left"


def test_pose_mirror_index_map_swaps_sides():
    from signavatar.capture.tracker import _POSE_MIRROR_INDEX
    from signavatar.schema import POSE_LANDMARK_NAMES

    names = POSE_LANDMARK_NAMES
    assert _POSE_MIRROR_INDEX[names.index("NOSE")] == names.index("NOSE")
    assert _POSE_MIRROR_INDEX[names.index("LEFT_SHOULDER")] == names.index("RIGHT_SHOULDER")
    assert _POSE_MIRROR_INDEX[names.index("RIGHT_WRIST")] == names.index("LEFT_WRIST")
    assert _POSE_MIRROR_INDEX[names.index("MOUTH_LEFT")] == names.index("MOUTH_RIGHT")
    # the swap is an involution: applying it twice is the identity
    assert [_POSE_MIRROR_INDEX[j] for j in _POSE_MIRROR_INDEX] == list(range(len(names)))
