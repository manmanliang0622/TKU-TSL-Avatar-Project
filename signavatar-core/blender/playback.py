"""Replay a SignAvatar recording as animated empties in Blender.

Run from the repo root:

    blender --python blender/playback.py -- recordings/samples/wave.json

Creates one empty per hand landmark (L_WRIST, R_INDEX_FINGER_TIP, ...) and
keyframes their locations for every recorded frame. This is the milestone-1
visual check of the pipeline; armature retargeting builds on top of it.
"""

import sys
from pathlib import Path

import bpy

# schema.py is stdlib-only precisely so this import works inside Blender.
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src"))
from signavatar.schema import HAND_LANDMARK_NAMES, load_recording  # noqa: E402

# How wide the webcam's field of view is assumed to be, in meters, at the
# signer's distance. Scales the image-space wrist anchor into scene space.
VIEW_WIDTH_M = 0.8
# Scene height of the view center, so hands float roughly at chest level.
BASE_HEIGHT_M = 1.2


def mp_to_blender(p):
    """MediaPipe (x right, y down, z toward camera) -> Blender (z up)."""
    return (p[0], p[2], -p[1])


def parse_cli_args():
    argv = sys.argv
    argv = argv[argv.index("--") + 1 :] if "--" in argv else []
    if len(argv) != 1:
        raise SystemExit("usage: blender --python blender/playback.py -- <recording.json>")
    return Path(argv[0])


def build_empties(collection):
    """One empty per (hand, landmark); returns {"Left": [...21], "Right": [...21]}."""
    empties = {}
    for side, prefix in (("Left", "L"), ("Right", "R")):
        empties[side] = []
        for name in HAND_LANDMARK_NAMES:
            obj = bpy.data.objects.new(f"{prefix}_{name}", None)
            obj.empty_display_type = "SPHERE"
            obj.empty_display_size = 0.008
            obj.hide_viewport = True
            obj.hide_render = True
            collection.objects.link(obj)
            empties[side].append(obj)
    return empties


def anchor_for(hand, aspect):
    """Scene-space offset for a hand, from its image-space wrist position.

    world_landmarks are centered on the hand, so global placement has to
    come from the normalized image coordinates.
    """
    wx, wy, _ = hand.landmarks[0]  # WRIST
    return (
        (wx - 0.5) * VIEW_WIDTH_M,
        0.0,
        (0.5 - wy) * VIEW_WIDTH_M * aspect + BASE_HEIGHT_M,
    )


def set_visibility(objs, hidden, frame):
    for obj in objs:
        obj.hide_viewport = hidden
        obj.hide_render = hidden
        obj.keyframe_insert("hide_viewport", frame=frame)
        obj.keyframe_insert("hide_render", frame=frame)


def main():
    recording_path = parse_cli_args()
    rec = load_recording(recording_path)

    scene = bpy.context.scene
    fps = max(1, round(rec.fps))
    scene.render.fps = fps

    collection = bpy.data.collections.new(f"SignAvatar_{rec.label or recording_path.stem}")
    scene.collection.children.link(collection)
    empties = build_empties(collection)

    aspect = rec.source_height / rec.source_width if rec.source_width else 1.0
    visible = {"Left": False, "Right": False}
    last_frame = 1

    for frame in rec.frames:
        blender_frame = round(frame.timestamp * fps) + 1
        last_frame = max(last_frame, blender_frame)
        present = {"Left": None, "Right": None}
        for hand in frame.hands:
            present[hand.handedness] = hand

        for side, hand in present.items():
            if hand is None:
                if visible[side]:
                    set_visibility(empties[side], hidden=True, frame=blender_frame)
                    visible[side] = False
                continue
            if not visible[side]:
                set_visibility(empties[side], hidden=False, frame=blender_frame)
                visible[side] = True
            ax, ay, az = anchor_for(hand, aspect)
            for obj, world_pt in zip(empties[side], hand.world_landmarks, strict=True):
                x, y, z = mp_to_blender(world_pt)
                obj.location = (ax + x, ay + y, az + z)
                obj.keyframe_insert("location", frame=blender_frame)

    scene.frame_start = 1
    scene.frame_end = last_frame
    scene.frame_set(1)
    print(
        f"SignAvatar: loaded {recording_path.name}: "
        f"{len(rec.frames)} frames -> scene frames 1..{last_frame} @ {fps} fps"
    )


main()
