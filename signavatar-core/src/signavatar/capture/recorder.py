"""Interactive webcam recording loop.

Controls in the preview window:
    R      toggle recording on/off
    Q/ESC  quit (saves if any frames were recorded)
"""

from __future__ import annotations

import time
from datetime import datetime, timezone
from pathlib import Path

import cv2

from signavatar.capture.tracker import FaceTracker, HandTracker, PoseTracker
from signavatar.schema import Frame, Recording, save_recording


def record(
    out_path: str | Path,
    camera_index: int = 0,
    max_hands: int = 2,
    label: str = "",
) -> Recording | None:
    """Run the preview/record loop. Returns the recording, or None if empty."""
    cap = cv2.VideoCapture(camera_index)
    if not cap.isOpened():
        raise RuntimeError(f"cannot open camera {camera_index}")

    width = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH))
    height = int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))

    frames: list[Frame] = []
    recording = False
    start_time = 0.0

    with (
        HandTracker(max_hands=max_hands) as tracker,
        PoseTracker() as pose_tracker,
        FaceTracker() as face_tracker,
    ):
        try:
            while True:
                ok, raw = cap.read()
                if not ok:
                    break
                frame = cv2.flip(raw, 1)  # selfie-view coords; trackers fix the labels

                hands = tracker.process(frame)
                pose = pose_tracker.process(frame)
                face = face_tracker.process(raw)  # raw: keeps blendshape L/R names anatomical

                if recording:
                    if not frames:
                        start_time = time.monotonic()
                    frames.append(
                        Frame(
                            index=len(frames),
                            timestamp=time.monotonic() - start_time,
                            hands=hands,
                            pose=pose,
                            face=face,
                        )
                    )

                tracker.draw_overlay(frame)
                status = f"REC {len(frames)} frames" if recording else "standby (R to record)"
                color = (0, 0, 255) if recording else (0, 255, 0)
                cv2.putText(frame, status, (10, 30), cv2.FONT_HERSHEY_SIMPLEX, 0.8, color, 2)
                cv2.imshow("SignAvatar capture", frame)

                key = cv2.waitKey(1) & 0xFF
                if key in (ord("q"), 27):
                    break
                if key == ord("r"):
                    recording = not recording
        finally:
            cap.release()
            cv2.destroyAllWindows()

    if not frames:
        return None

    duration = frames[-1].timestamp
    fps = (len(frames) - 1) / duration if duration > 0 else 0.0
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
