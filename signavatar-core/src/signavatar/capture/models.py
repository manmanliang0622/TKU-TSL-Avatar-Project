"""Download and cache MediaPipe task model files."""

from __future__ import annotations

import urllib.request
from pathlib import Path

HAND_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/hand_landmarker/"
    "hand_landmarker/float16/1/hand_landmarker.task"
)

POSE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/pose_landmarker/"
    "pose_landmarker_full/float16/1/pose_landmarker_full.task"
)

FACE_LANDMARKER_URL = (
    "https://storage.googleapis.com/mediapipe-models/face_landmarker/"
    "face_landmarker/float16/1/face_landmarker.task"
)

CACHE_DIR = Path.home() / ".cache" / "signavatar"


def _ensure_model(filename: str, url: str) -> Path:
    path = CACHE_DIR / filename
    if path.exists():
        return path
    CACHE_DIR.mkdir(parents=True, exist_ok=True)
    print(f"downloading {filename} to {path} ...")
    tmp = path.with_suffix(".tmp")
    urllib.request.urlretrieve(url, tmp)
    tmp.rename(path)
    return path


def ensure_hand_landmarker_model() -> Path:
    """Return the local path to hand_landmarker.task, downloading it once."""
    return _ensure_model("hand_landmarker.task", HAND_LANDMARKER_URL)


def ensure_pose_landmarker_model() -> Path:
    """Return the local path to pose_landmarker_full.task, downloading it once."""
    return _ensure_model("pose_landmarker_full.task", POSE_LANDMARKER_URL)


def ensure_face_landmarker_model() -> Path:
    """Return the local path to face_landmarker.task, downloading it once."""
    return _ensure_model("face_landmarker.task", FACE_LANDMARKER_URL)
