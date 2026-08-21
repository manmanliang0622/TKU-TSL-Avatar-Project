import pytest

from signavatar.schema import (
    NUM_HAND_LANDMARKS,
    NUM_POSE_LANDMARKS,
    FaceFrame,
    Frame,
    HandFrame,
    PoseFrame,
    Recording,
    SchemaError,
    load_recording,
    save_recording,
)


def make_hand(handedness="Left"):
    return HandFrame(
        handedness=handedness,
        score=0.97,
        landmarks=[(0.5, 0.5, 0.0)] * NUM_HAND_LANDMARKS,
        world_landmarks=[(0.01, -0.02, 0.03)] * NUM_HAND_LANDMARKS,
    )


def make_pose():
    return PoseFrame(
        landmarks=[(0.5, 0.4, -0.1)] * NUM_POSE_LANDMARKS,
        world_landmarks=[(0.1, -0.2, 0.3)] * NUM_POSE_LANDMARKS,
        visibility=[0.9] * NUM_POSE_LANDMARKS,
    )


def make_recording():
    return Recording(
        fps=30.0,
        source_width=640,
        source_height=480,
        created_at="2026-07-04T00:00:00+00:00",
        label="wave",
        frames=[
            Frame(index=0, timestamp=0.0, hands=[make_hand("Left"), make_hand("Right")]),
            Frame(index=1, timestamp=0.033, hands=[]),
            Frame(
                index=2,
                timestamp=0.066,
                hands=[make_hand("Right")],
                pose=make_pose(),
                face=FaceFrame(blendshapes={"browInnerUp": 0.8, "jawOpen": 0.2}),
            ),
        ],
    )


def test_round_trip(tmp_path):
    path = tmp_path / "rec.json"
    original = make_recording()
    save_recording(original, path)
    loaded = load_recording(path)
    assert loaded == original


def test_duration():
    assert make_recording().duration == pytest.approx(0.066)
    assert Recording(fps=30, source_width=1, source_height=1, created_at="").duration == 0.0


def test_rejects_wrong_landmark_count():
    hand = make_hand()
    hand.landmarks = hand.landmarks[:-1]
    with pytest.raises(SchemaError, match="21 points"):
        hand.validate()


def test_rejects_bad_handedness():
    hand = make_hand()
    hand.handedness = "left"
    with pytest.raises(SchemaError, match="handedness"):
        hand.validate()


def test_face_rejects_empty_blendshapes():
    with pytest.raises(SchemaError, match="blendshapes"):
        FaceFrame(blendshapes={}).validate()


def test_pose_rejects_wrong_landmark_count():
    pose = make_pose()
    pose.visibility = pose.visibility[:-1]
    with pytest.raises(SchemaError, match="33"):
        pose.validate()


def test_loads_version_1_files_without_pose(tmp_path):
    """v1 recordings (hands only) must stay loadable."""
    path = tmp_path / "rec.json"
    rec = make_recording()
    rec.frames = [Frame(index=0, timestamp=0.0, hands=[make_hand()])]
    save_recording(rec, path)
    content = path.read_text().replace('"version": 2', '"version": 1')
    path.write_text(content)
    loaded = load_recording(path)
    assert loaded.frames[0].pose is None
    assert loaded.frames[0].hands[0] == make_hand()


def test_rejects_unknown_version(tmp_path):
    path = tmp_path / "rec.json"
    save_recording(make_recording(), path)
    content = path.read_text().replace('"version": 2', '"version": 99')
    path.write_text(content)
    with pytest.raises(SchemaError, match="version"):
        load_recording(path)


def test_schema_module_is_stdlib_only():
    """schema.py must be importable inside Blender's bundled Python."""
    import ast
    import sys
    from pathlib import Path

    import signavatar.schema

    source = Path(signavatar.schema.__file__).read_text()
    for node in ast.walk(ast.parse(source)):
        names = []
        if isinstance(node, ast.Import):
            names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.level == 0:
            names = [node.module]
        for name in names:
            root = name.split(".")[0]
            assert root in sys.stdlib_module_names, f"non-stdlib import in schema.py: {name}"
