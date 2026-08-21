"""MediaPipe hand tracking wrapper (Tasks API).

mediapipe >= 0.10.x removed the legacy mp.solutions API, so this uses
HandLandmarker in VIDEO mode. The model file is downloaded once to
~/.cache/signavatar/ by models.ensure_hand_landmarker_model().
"""

from __future__ import annotations

import time
from pathlib import Path

import cv2
import mediapipe as mp
import numpy as np
from mediapipe.tasks.python.core.base_options import BaseOptions
from mediapipe.tasks.python.vision import (
    FaceLandmarker,
    FaceLandmarkerOptions,
    HandLandmarker,
    HandLandmarkerOptions,
    PoseLandmarker,
    PoseLandmarkerOptions,
    RunningMode,
)

from signavatar.capture.models import (
    ensure_face_landmarker_model,
    ensure_hand_landmarker_model,
    ensure_pose_landmarker_model,
)
from signavatar.schema import (
    HAND_CONNECTIONS,
    POSE_LANDMARK_NAMES,
    FaceFrame,
    HandFrame,
    PoseFrame,
)


def _mirrored_pose_index_map() -> list[int]:
    """For each schema pose index, the detector index holding it in a flipped frame.

    Like handedness, the pose model reports anatomical LEFT_*/RIGHT_* for
    unmirrored input, so detections on selfie-flipped frames have the sides
    swapped and must be read from the opposite index.
    """
    index_of = {name: i for i, name in enumerate(POSE_LANDMARK_NAMES)}

    def opposite(name: str) -> str:
        for a, b in (("LEFT", "RIGHT"), ("RIGHT", "LEFT")):
            if name.startswith(a + "_"):
                return b + name[len(a) :]
            if name.endswith("_" + a):
                return name[: -len(a)] + b
        return name

    return [index_of[opposite(name)] for name in POSE_LANDMARK_NAMES]


_POSE_MIRROR_INDEX = _mirrored_pose_index_map()


def mirrored_handedness(label: str) -> str:
    """True hand for a detection in a selfie-flipped frame.

    The Tasks-API HandLandmarker reports handedness for *unmirrored* input
    (unlike the removed mp.solutions API, which assumed selfie view), so a
    label from a flipped frame names the wrong hand and must be swapped.
    """
    return "Left" if label == "Right" else "Right"


class HandTracker:
    """Detects hands in BGR frames and returns schema HandFrame objects.

    Frames are expected to already be selfie-flipped (mirrored) — that keeps
    recordings in selfie-view image coordinates. Handedness labels are
    swapped back accordingly (see mirrored_handedness) so "Left"/"Right"
    always mean the signer's actual hands.
    """

    def __init__(
        self,
        max_hands: int = 2,
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        model_path: str | Path | None = None,
    ):
        options = HandLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_path=str(model_path or ensure_hand_landmarker_model())
            ),
            running_mode=RunningMode.VIDEO,
            num_hands=max_hands,
            min_hand_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )
        self._landmarker = HandLandmarker.create_from_options(options)
        self._t0 = time.monotonic()
        self._last_timestamp_ms = -1
        self._last_hands: list[HandFrame] = []

    def process(self, bgr_frame: np.ndarray, timestamp_ms: int | None = None) -> list[HandFrame]:
        """Detect hands in one frame.

        timestamp_ms: media time of the frame, for offline sources like
        video files. Defaults to wall-clock time (live capture).
        """
        rgb = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        # VIDEO mode requires strictly increasing timestamps.
        if timestamp_ms is None:
            timestamp_ms = int((time.monotonic() - self._t0) * 1000)
        timestamp_ms = max(timestamp_ms, self._last_timestamp_ms + 1)
        self._last_timestamp_ms = timestamp_ms

        result = self._landmarker.detect_for_video(image, timestamp_ms)

        hands = []
        for image_lms, world_lms, categories in zip(
            result.hand_landmarks,
            result.hand_world_landmarks,
            result.handedness,
            strict=True,
        ):
            hand = HandFrame(
                handedness=mirrored_handedness(categories[0].category_name),
                score=categories[0].score,
                landmarks=[(lm.x, lm.y, lm.z) for lm in image_lms],
                world_landmarks=[(lm.x, lm.y, lm.z) for lm in world_lms],
            )
            hand.validate()
            hands.append(hand)
        self._last_hands = hands
        return hands

    def draw_overlay(self, bgr_frame: np.ndarray) -> None:
        """Draw the most recent detection onto the frame, in place."""
        h, w = bgr_frame.shape[:2]
        for hand in self._last_hands:
            points = [(int(x * w), int(y * h)) for x, y, _ in hand.landmarks]
            for a, b in HAND_CONNECTIONS:
                cv2.line(bgr_frame, points[a], points[b], (255, 255, 255), 2)
            for pt in points:
                cv2.circle(bgr_frame, pt, 4, (0, 128, 255), -1)

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> HandTracker:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class FaceTracker:
    """Extracts ARKit-style face blendshapes from BGR frames.

    Unlike Hand/PoseTracker this takes the *unflipped* frame: blendshape
    names carry Left/Right (eyeBlinkLeft, ...), and the model names them
    anatomically for unmirrored input — raw frames need no swapping.
    (With extract --no-mirror the footage is already mirrored and face
    Left/Right names come out swapped; acceptable for the rare case.)
    """

    def __init__(self, model_path: str | Path | None = None):
        options = FaceLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_path=str(model_path or ensure_face_landmarker_model())
            ),
            running_mode=RunningMode.VIDEO,
            num_faces=1,
            output_face_blendshapes=True,
        )
        self._landmarker = FaceLandmarker.create_from_options(options)
        self._t0 = time.monotonic()
        self._last_timestamp_ms = -1

    def process(self, bgr_frame: np.ndarray, timestamp_ms: int | None = None) -> FaceFrame | None:
        """Detect the signer's facial expression in one unflipped frame."""
        rgb = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        if timestamp_ms is None:
            timestamp_ms = int((time.monotonic() - self._t0) * 1000)
        timestamp_ms = max(timestamp_ms, self._last_timestamp_ms + 1)
        self._last_timestamp_ms = timestamp_ms

        result = self._landmarker.detect_for_video(image, timestamp_ms)
        if not result.face_blendshapes:
            return None

        face = FaceFrame(blendshapes={c.category_name: c.score for c in result.face_blendshapes[0]})
        face.validate()
        return face

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> FaceTracker:
        return self

    def __exit__(self, *exc) -> None:
        self.close()


class PoseTracker:
    """Detects body pose in BGR frames and returns schema PoseFrame objects.

    Takes the same selfie-flipped frames as HandTracker; LEFT_*/RIGHT_*
    landmark indices are swapped back after detection so they name the
    signer's actual sides (see _mirrored_pose_index_map).
    """

    def __init__(
        self,
        min_detection_confidence: float = 0.5,
        min_tracking_confidence: float = 0.5,
        model_path: str | Path | None = None,
    ):
        options = PoseLandmarkerOptions(
            base_options=BaseOptions(
                model_asset_path=str(model_path or ensure_pose_landmarker_model())
            ),
            running_mode=RunningMode.VIDEO,
            num_poses=1,
            min_pose_detection_confidence=min_detection_confidence,
            min_tracking_confidence=min_tracking_confidence,
        )
        self._landmarker = PoseLandmarker.create_from_options(options)
        self._t0 = time.monotonic()
        self._last_timestamp_ms = -1

    def process(self, bgr_frame: np.ndarray, timestamp_ms: int | None = None) -> PoseFrame | None:
        """Detect the signer's pose in one selfie-flipped frame."""
        rgb = cv2.cvtColor(bgr_frame, cv2.COLOR_BGR2RGB)
        image = mp.Image(image_format=mp.ImageFormat.SRGB, data=rgb)

        if timestamp_ms is None:
            timestamp_ms = int((time.monotonic() - self._t0) * 1000)
        timestamp_ms = max(timestamp_ms, self._last_timestamp_ms + 1)
        self._last_timestamp_ms = timestamp_ms

        result = self._landmarker.detect_for_video(image, timestamp_ms)
        if not result.pose_landmarks:
            return None

        lms = result.pose_landmarks[0]
        wlms = result.pose_world_landmarks[0]
        pose = PoseFrame(
            landmarks=[(lms[j].x, lms[j].y, lms[j].z) for j in _POSE_MIRROR_INDEX],
            world_landmarks=[(wlms[j].x, wlms[j].y, wlms[j].z) for j in _POSE_MIRROR_INDEX],
            visibility=[lms[j].visibility for j in _POSE_MIRROR_INDEX],
        )
        pose.validate()
        return pose

    def close(self) -> None:
        self._landmarker.close()

    def __enter__(self) -> PoseTracker:
        return self

    def __exit__(self, *exc) -> None:
        self.close()
