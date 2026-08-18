"""Generate a synthetic waving-hand recording for testing playback without a webcam.

uv run python tools/make_synthetic_sample.py [out.json]
"""

from __future__ import annotations

import math
import sys
from datetime import datetime, timezone
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from signavatar.schema import Frame, HandFrame, Recording, save_recording  # noqa: E402

FPS = 30
DURATION_S = 3.0
WAVE_HZ = 0.8

# Flat open right hand, palm to camera, fingers up. Meters, hand-centered,
# MediaPipe world convention (x right, y down, z toward camera).
FLAT_HAND = [
    (0.000, 0.080, 0.0),  # WRIST
    (-0.030, 0.050, 0.0),
    (-0.045, 0.020, 0.0),
    (-0.055, 0.000, 0.0),
    (-0.065, -0.015, 0.0),
    (-0.025, 0.000, 0.0),
    (-0.028, -0.030, 0.0),
    (-0.030, -0.050, 0.0),
    (-0.031, -0.065, 0.0),
    (0.000, 0.000, 0.0),
    (0.000, -0.035, 0.0),
    (0.000, -0.058, 0.0),
    (0.000, -0.075, 0.0),
    (0.023, 0.000, 0.0),
    (0.025, -0.030, 0.0),
    (0.027, -0.052, 0.0),
    (0.028, -0.068, 0.0),
    (0.045, 0.005, 0.0),
    (0.050, -0.020, 0.0),
    (0.053, -0.038, 0.0),
    (0.055, -0.050, 0.0),
]


def rotate_z(points, angle):
    c, s = math.cos(angle), math.sin(angle)
    return [(x * c - y * s, x * s + y * c, z) for x, y, z in points]


def main():
    out = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("recordings/samples/synthetic_wave.json")
    frames = []
    for i in range(int(FPS * DURATION_S)):
        t = i / FPS
        phase = 2 * math.pi * WAVE_HZ * t
        world = rotate_z(FLAT_HAND, 0.35 * math.sin(phase))
        # Image-space anchor sways side to side; wrist is landmarks[0].
        wx = 0.65 + 0.12 * math.sin(phase)
        wy = 0.45
        image = [(wx + x / 0.8, wy + y / 0.6, 0.0) for x, y, z in world]
        hand = HandFrame(handedness="Right", score=1.0, landmarks=image, world_landmarks=world)
        hand.validate()
        frames.append(Frame(index=i, timestamp=t, hands=[hand]))

    rec = Recording(
        fps=FPS,
        source_width=640,
        source_height=480,
        created_at=datetime.now(timezone.utc).isoformat(),
        label="synthetic_wave",
        frames=frames,
    )
    out.parent.mkdir(parents=True, exist_ok=True)
    save_recording(rec, out)
    print(f"wrote {out}: {len(frames)} frames, {rec.duration:.2f}s")


if __name__ == "__main__":
    main()
