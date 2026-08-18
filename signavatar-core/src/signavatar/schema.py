"""Landmark recording format shared by the capture and Blender environments.

This module is the contract between the two runtimes: the capture side
(a normal venv with MediaPipe/OpenCV) writes recordings, and the Blender
side (Blender's bundled Python, bpy only) reads them. It must stay
stdlib-only so both environments can import it unchanged.
"""

from __future__ import annotations

import json
from dataclasses import dataclass, field
from pathlib import Path

SCHEMA_VERSION = 2
# v1: hands only. v2: adds optional per-frame body pose and face blendshapes.
SUPPORTED_VERSIONS = (1, 2)

NUM_HAND_LANDMARKS = 21
NUM_POSE_LANDMARKS = 33

# Index order follows MediaPipe's hand landmark model.
HAND_LANDMARK_NAMES = [
    "WRIST",
    "THUMB_CMC",
    "THUMB_MCP",
    "THUMB_IP",
    "THUMB_TIP",
    "INDEX_FINGER_MCP",
    "INDEX_FINGER_PIP",
    "INDEX_FINGER_DIP",
    "INDEX_FINGER_TIP",
    "MIDDLE_FINGER_MCP",
    "MIDDLE_FINGER_PIP",
    "MIDDLE_FINGER_DIP",
    "MIDDLE_FINGER_TIP",
    "RING_FINGER_MCP",
    "RING_FINGER_PIP",
    "RING_FINGER_DIP",
    "RING_FINGER_TIP",
    "PINKY_MCP",
    "PINKY_PIP",
    "PINKY_DIP",
    "PINKY_TIP",
]

# Landmark index pairs forming the hand skeleton (thumb, four fingers, palm).
HAND_CONNECTIONS = [
    (0, 1),
    (1, 2),
    (2, 3),
    (3, 4),
    (0, 5),
    (5, 6),
    (6, 7),
    (7, 8),
    (5, 9),
    (9, 10),
    (10, 11),
    (11, 12),
    (9, 13),
    (13, 14),
    (14, 15),
    (15, 16),
    (13, 17),
    (17, 18),
    (18, 19),
    (19, 20),
    (0, 17),
]

# Index order follows MediaPipe's pose landmark model. LEFT_*/RIGHT_* are the
# signer's actual sides (capture mirrors coordinates, not the labels).
POSE_LANDMARK_NAMES = [
    "NOSE",
    "LEFT_EYE_INNER",
    "LEFT_EYE",
    "LEFT_EYE_OUTER",
    "RIGHT_EYE_INNER",
    "RIGHT_EYE",
    "RIGHT_EYE_OUTER",
    "LEFT_EAR",
    "RIGHT_EAR",
    "MOUTH_LEFT",
    "MOUTH_RIGHT",
    "LEFT_SHOULDER",
    "RIGHT_SHOULDER",
    "LEFT_ELBOW",
    "RIGHT_ELBOW",
    "LEFT_WRIST",
    "RIGHT_WRIST",
    "LEFT_PINKY",
    "RIGHT_PINKY",
    "LEFT_INDEX",
    "RIGHT_INDEX",
    "LEFT_THUMB",
    "RIGHT_THUMB",
    "LEFT_HIP",
    "RIGHT_HIP",
    "LEFT_KNEE",
    "RIGHT_KNEE",
    "LEFT_ANKLE",
    "RIGHT_ANKLE",
    "LEFT_HEEL",
    "RIGHT_HEEL",
    "LEFT_FOOT_INDEX",
    "RIGHT_FOOT_INDEX",
]

# Landmark index pairs forming the body skeleton (face links, arms, torso, legs).
POSE_CONNECTIONS = [
    (0, 1),
    (1, 2),
    (2, 3),
    (3, 7),
    (0, 4),
    (4, 5),
    (5, 6),
    (6, 8),
    (9, 10),
    (11, 12),
    (11, 13),
    (13, 15),
    (15, 17),
    (15, 19),
    (15, 21),
    (17, 19),
    (12, 14),
    (14, 16),
    (16, 18),
    (16, 20),
    (16, 22),
    (18, 20),
    (11, 23),
    (12, 24),
    (23, 24),
    (23, 25),
    (25, 27),
    (27, 29),
    (29, 31),
    (27, 31),
    (24, 26),
    (26, 28),
    (28, 30),
    (30, 32),
    (28, 32),
]

Vec3 = tuple[float, float, float]

# Storage precision: 1e-5 in normalized/metric units is far below sensor
# noise but roughly halves file size versus full float repr.
_COORD_DECIMALS = 5
_SCORE_DECIMALS = 4


def _round_points(pts: list[Vec3]) -> list[list[float]]:
    return [[round(c, _COORD_DECIMALS) for c in p] for p in pts]


class SchemaError(ValueError):
    """Raised when a recording file does not match the expected format."""


@dataclass
class HandFrame:
    """One detected hand in one frame.

    landmarks: normalized image coordinates (x, y in [0, 1], z relative
        to wrist depth). Used to anchor the hand in screen space.
    world_landmarks: metric coordinates in meters, origin at the hand's
        geometric center. Used for the hand's 3D shape. Note: these carry
        no global position — placement must come from `landmarks`.
    """

    handedness: str  # "Left" or "Right", from the signer's perspective (selfie view)
    score: float
    landmarks: list[Vec3]
    world_landmarks: list[Vec3]

    def validate(self) -> None:
        if self.handedness not in ("Left", "Right"):
            raise SchemaError(f"handedness must be Left/Right, got {self.handedness!r}")
        for name, pts in (("landmarks", self.landmarks), ("world_landmarks", self.world_landmarks)):
            if len(pts) != NUM_HAND_LANDMARKS:
                raise SchemaError(f"{name} must have {NUM_HAND_LANDMARKS} points, got {len(pts)}")

    def to_dict(self) -> dict:
        return {
            "handedness": self.handedness,
            "score": round(self.score, _SCORE_DECIMALS),
            "landmarks": _round_points(self.landmarks),
            "world_landmarks": _round_points(self.world_landmarks),
        }

    @classmethod
    def from_dict(cls, d: dict) -> HandFrame:
        hand = cls(
            handedness=d["handedness"],
            score=d["score"],
            landmarks=[tuple(p) for p in d["landmarks"]],
            world_landmarks=[tuple(p) for p in d["world_landmarks"]],
        )
        hand.validate()
        return hand


@dataclass
class PoseFrame:
    """Whole-body pose in one frame.

    landmarks: normalized image coordinates (selfie view, like HandFrame).
    world_landmarks: meters, origin at the hip midpoint.
    visibility: per-landmark confidence that the point is visible in frame.
    """

    landmarks: list[Vec3]
    world_landmarks: list[Vec3]
    visibility: list[float]

    def validate(self) -> None:
        for name, seq in (
            ("landmarks", self.landmarks),
            ("world_landmarks", self.world_landmarks),
            ("visibility", self.visibility),
        ):
            if len(seq) != NUM_POSE_LANDMARKS:
                raise SchemaError(
                    f"pose {name} must have {NUM_POSE_LANDMARKS} entries, got {len(seq)}"
                )

    def to_dict(self) -> dict:
        return {
            "landmarks": _round_points(self.landmarks),
            "world_landmarks": _round_points(self.world_landmarks),
            "visibility": [round(v, _SCORE_DECIMALS) for v in self.visibility],
        }

    @classmethod
    def from_dict(cls, d: dict) -> PoseFrame:
        pose = cls(
            landmarks=[tuple(p) for p in d["landmarks"]],
            world_landmarks=[tuple(p) for p in d["world_landmarks"]],
            visibility=list(d["visibility"]),
        )
        pose.validate()
        return pose


@dataclass
class FaceFrame:
    """Facial expression in one frame.

    blendshapes: ARKit-style coefficient scores in [0, 1] keyed by name
    (browInnerUp, jawOpen, mouthSmileLeft, ...). Left/Right in the names
    are the signer's actual sides. Drives avatar shape keys directly.
    """

    blendshapes: dict[str, float]

    def validate(self) -> None:
        if not self.blendshapes:
            raise SchemaError("face blendshapes must not be empty")

    def to_dict(self) -> dict:
        return {"blendshapes": {k: round(v, _SCORE_DECIMALS) for k, v in self.blendshapes.items()}}

    @classmethod
    def from_dict(cls, d: dict) -> FaceFrame:
        face = cls(blendshapes=dict(d["blendshapes"]))
        face.validate()
        return face


@dataclass
class Frame:
    index: int
    timestamp: float  # seconds since recording start
    hands: list[HandFrame] = field(default_factory=list)
    pose: PoseFrame | None = None
    face: FaceFrame | None = None

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "timestamp": round(self.timestamp, _COORD_DECIMALS),
            "hands": [h.to_dict() for h in self.hands],
            "pose": self.pose.to_dict() if self.pose else None,
            "face": self.face.to_dict() if self.face else None,
        }

    @classmethod
    def from_dict(cls, d: dict) -> Frame:
        pose = d.get("pose")
        face = d.get("face")
        return cls(
            index=d["index"],
            timestamp=d["timestamp"],
            hands=[HandFrame.from_dict(h) for h in d["hands"]],
            pose=PoseFrame.from_dict(pose) if pose else None,
            face=FaceFrame.from_dict(face) if face else None,
        )


@dataclass
class Recording:
    fps: float  # nominal capture rate, measured over the recording
    source_width: int
    source_height: int
    created_at: str  # ISO 8601
    frames: list[Frame] = field(default_factory=list)
    label: str = ""  # e.g. the sign being performed
    version: int = SCHEMA_VERSION

    @property
    def duration(self) -> float:
        return self.frames[-1].timestamp if self.frames else 0.0

    def to_dict(self) -> dict:
        return {
            "version": self.version,
            "label": self.label,
            "fps": self.fps,
            "source_width": self.source_width,
            "source_height": self.source_height,
            "created_at": self.created_at,
            "frames": [f.to_dict() for f in self.frames],
        }

    @classmethod
    def from_dict(cls, d: dict) -> Recording:
        version = d.get("version")
        if version not in SUPPORTED_VERSIONS:
            raise SchemaError(
                f"unsupported schema version {version!r}, expected one of {SUPPORTED_VERSIONS}"
            )
        return cls(
            version=version,
            label=d.get("label", ""),
            fps=d["fps"],
            source_width=d["source_width"],
            source_height=d["source_height"],
            created_at=d["created_at"],
            frames=[Frame.from_dict(f) for f in d["frames"]],
        )


def save_recording(recording: Recording, path: str | Path) -> None:
    Path(path).write_text(json.dumps(recording.to_dict()), encoding="utf-8")


def load_recording(path: str | Path) -> Recording:
    return Recording.from_dict(json.loads(Path(path).read_text(encoding="utf-8")))
