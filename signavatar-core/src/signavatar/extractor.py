"""Offline extraction: run hand tracking over a video file instead of a webcam.

Frames are selfie-flipped by default, same as the live recorder, so that
MediaPipe's handedness labels match the signer's actual hands (normal
third-person footage of a signer is unmirrored, like a raw webcam feed).
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import datetime, timezone
from pathlib import Path

import cv2

from signavatar.capture.tracker import FaceTracker, HandTracker, PoseTracker
from signavatar.schema import Frame, Recording, save_recording

_FALLBACK_FPS = 30.0


def extract(
    video_path: str | Path,
    out_path: str | Path,
    max_hands: int = 2,
    label: str = "",
    mirror: bool = True,
    include_pose: bool = True,
    include_face: bool = True,
    crop: tuple[float, float] | None = None,
    on_progress: Callable[[int, int], None] | None = None,
) -> Recording | None:
    """Track hands, body pose, and face blendshapes in every frame of a video.

    Returns the recording, or None if the video has no frames.
    on_progress: called as on_progress(frames_done, total_frames) roughly
    once per second of video; total_frames is 0 when unknown.

    crop: (x0, x1) as fractions of width, keeping only that horizontal slice.
    The corpus dialogue units put two signers side by side in one frame, so
    (0, 0.5) / (0.5, 1) picks one of them and the rest of the single-signer
    pipeline applies unchanged. Landmarks are normalised to whatever frame
    MediaPipe sees, so source_width/height record the cropped size.
    """
    cap = cv2.VideoCapture(str(video_path))
    if not cap.isOpened():
        raise RuntimeError(f"cannot open video {video_path}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    x0, x1 = 0, width
    if crop:
        x0, x1 = int(round(width * crop[0])), int(round(width * crop[1]))
        if not 0 <= x0 < x1 <= width:
            cap.release()
            raise ValueError(f"crop {crop} out of range for width {width}")
        width = x1 - x0
    fps = cap.get(cv2.CAP_PROP_FPS)
    if not fps or fps != fps:  # 0 or NaN: container didn't say
        fps = _FALLBACK_FPS
    total = max(0, int(cap.get(cv2.CAP_PROP_FRAME_COUNT)))
    report_every = max(1, round(fps))

    frames: list[Frame] = []
    pose_tracker = PoseTracker() if include_pose else None
    face_tracker = FaceTracker() if include_face else None
    try:
        with HandTracker(max_hands=max_hands) as tracker:
            while True:
                ok, raw = cap.read()
                if not ok:
                    break
                # crop BEFORE the selfie flip: flipping the whole frame first
                # would move the left-hand signer to the right half
                region = raw[:, x0:x1] if crop else raw
                frame = cv2.flip(region, 1) if mirror else region
                timestamp = len(frames) / fps
                timestamp_ms = round(timestamp * 1000)
                hands = tracker.process(frame, timestamp_ms=timestamp_ms)
                pose = (
                    pose_tracker.process(frame, timestamp_ms=timestamp_ms) if pose_tracker else None
                )
                # face reads the raw frame: blendshape L/R names stay anatomical
                face = (
                    face_tracker.process(region, timestamp_ms=timestamp_ms)
                    if face_tracker
                    else None
                )
                frames.append(
                    Frame(index=len(frames), timestamp=timestamp, hands=hands, pose=pose, face=face)
                )
                if on_progress and len(frames) % report_every == 0:
                    on_progress(len(frames), total)
    finally:
        if pose_tracker:
            pose_tracker.close()
        if face_tracker:
            face_tracker.close()
        cap.release()

    if not frames:
        return None

    rec = Recording(
        fps=fps,
        source_width=width,
        source_height=height,
        created_at=datetime.now(timezone.utc).isoformat(),
        frames=frames,
        label=label,
    )
    save_recording(rec, out_path)
    return rec
