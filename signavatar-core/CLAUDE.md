# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project

SignAvatar (台灣手語虛擬人動畫系統): records sign language hand motion from a
webcam via MediaPipe, stores it as JSON landmark recordings, and replays it in
Blender. Current milestone is the motion pipeline (capture → JSON → Blender
landmark playback), not sign translation. See README.md for the roadmap.

## Commands

```bash
uv sync                                  # create venv + install deps
uv run pytest                            # run tests
uv run pytest tests/test_schema.py::test_round_trip   # single test
uv run ruff check . && uv run ruff format .           # lint / format

uv run signavatar record recordings/x.json --label x  # record (needs webcam; R toggles, Q quits)
uv run signavatar extract video.mp4 recordings/x.json # track hands in a video file instead
uv run signavatar corpus list                         # MOC TSL corpus units (文化部語料庫)
uv run signavatar corpus ingest G2D1P1                # video→extract→word-level lexicon entries
uv run signavatar corpus pairs                        # harvest 中文↔gloss pairs (all units, API-only)
uv run signavatar info recordings/x.json              # summarize a recording
uv run signavatar view recordings/x.json              # web viewer (serves web/viewer.html)
uv run signavatar view recordings/x.json --video v.mp4 # + synced source-video comparison

# Playback runs inside Blender, NOT the venv:
blender --python blender/playback.py -- recordings/x.json
# macOS path: /Applications/Blender.app/Contents/MacOS/Blender

uv run python tools/make_synthetic_sample.py   # test recording, no webcam needed
```

## Blender MCP

The official Blender MCP (projects.blender.org/lab/blender_mcp, cloned at
`~/.local/share/blender_mcp`) is registered as the `blender` MCP server in
this project's local config. Its `mcp` add-on is installed in Blender (≥5.1)
with auto-start on; the bridge listens on localhost:9876 once Blender is
running. Use it (`execute_blender_code`, `get_objects_summary`,
`get_screenshot_of_area_as_image`, ...) to drive and visually verify playback
in a live Blender instead of headless runs.

## Architecture: two runtimes, one contract

The codebase is split across two Python environments that cannot share
dependencies:

1. **Capture side** (`src/signavatar/`): runs in the uv venv with
   mediapipe/opencv/numpy. Entry point is `cli.py` → `capture/recorder.py`
   (webcam loop) → `capture/tracker.py` (MediaPipe wrapper).
2. **Blender side** (`blender/`): runs inside Blender's bundled Python where
   only `bpy` and the stdlib exist. mediapipe/cv2 can never be imported here.

The JSON recording format defined in `src/signavatar/schema.py` is the
contract between them. Blender scripts import it by inserting `src/` into
`sys.path`, which only works because **schema.py must stay stdlib-only** —
a test (`test_schema_module_is_stdlib_only`) enforces this. Format changes
require bumping `SCHEMA_VERSION` and keeping `from_dict` validation in sync.

## Domain gotchas

- MediaPipe hands yields two coordinate sets per hand, and both are needed:
  `world_landmarks` (meters, origin at the hand's center — gives hand *shape*
  but no global position) and `landmarks` (normalized image coords — used to
  anchor the hand in scene space, see `anchor_for()` in `blender/playback.py`).
- Coordinate systems differ: MediaPipe is x-right/y-down/z-toward-camera;
  Blender is z-up. The mapping lives in `mp_to_blender()` only.
- The recorder/extractor selfie-flip frames (`cv2.flip(frame, 1)`) before
  tracking so recordings use selfie-view image coordinates. The Tasks-API
  HandLandmarker reports handedness for *unmirrored* input (opposite of the
  old mp.solutions convention), so `HandTracker` swaps the labels back
  (`mirrored_handedness()`) and `PoseTracker` swaps LEFT_*/RIGHT_* landmark
  indices (`_mirrored_pose_index_map()`); recordings always store the
  signer's true sides. Don't feed unflipped frames to the trackers.
- mediapipe 0.10.35+ has **no `mp.solutions` API** (removed upstream); only
  the Tasks API exists. The tracker uses `HandLandmarker` in VIDEO mode, which
  requires strictly increasing `timestamp_ms` values and a `.task` model file
  that `capture/models.py` downloads once to `~/.cache/signavatar/`.
- Recordings use wall-clock timestamps per frame, not a fixed frame rate;
  `fps` in a recording is a measured average. Playback maps timestamps to
  Blender frames with `round(timestamp * fps) + 1`.
- MediaPipe z is more NEGATIVE toward the camera (image and world alike).
  The web viewer maps scene depth as `-z`; `web/avatar3d.js` documents the
  full recording→avatar axis chain (`mpToAvatar`, kalidokit wants
  unmirrored input, palm bases must be right-handed).
