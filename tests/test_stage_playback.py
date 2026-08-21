"""Guards for the three stage fixes that a later edit could quietly undo.

Each of these was a real defect with a real cause, and each cause is a single
line that looks harmless on its own — which is exactly why they are pinned
here rather than left to be rediscovered.
"""

from pathlib import Path
import re
import unittest


ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (ROOT / name).read_text(encoding="utf-8-sig")


class ClipFetchingTests(unittest.TestCase):
    def test_build_asks_for_clips_not_whole_recordings(self):
        """A sentence must not pull the files its words happen to live in.

        「我」 is 0.3 seconds of an 11.5 MB interview recording. Building a
        sentence out of whole recordings downloaded 33 MB to keep about 1%
        of it, and that was six of the eleven seconds a user waited.
        """
        composer = read("composer.js")
        build = composer[composer.index("async function build("):]
        self.assertIn("fetchSegments(clipRequests(", build)
        self.assertNotIn("fetchRecordingByName", build[: build.index("window.Composer")])

    def test_recordings_are_allowed_into_the_browser_cache(self):
        """no-store re-downloaded megabytes that can never have changed."""
        composer = read("composer.js")
        fetches = re.findall(r"fetch\(`recordings/[^\n]*", composer)
        self.assertTrue(fetches)
        for call in fetches:
            self.assertNotIn("no-store", call)

    def test_a_missing_clip_endpoint_falls_back_to_whole_files(self):
        """Static hosting cannot slice, and must still work — just slowly."""
        composer = read("composer.js")
        self.assertIn("clipEndpointOk = false;", composer)
        self.assertIn("fetchRecordingByName(name)", composer)


class PlaybackGateTests(unittest.TestCase):
    def test_the_avatar_stands_at_rest_while_there_is_nothing_to_play(self):
        """Otherwise it holds the VRM bind pose — arms straight out — while
        the sentence loads, which reads as broken rather than loading."""
        self.assertIn("function idle(dt)", read("avatar3d.js"))
        bridge = read("signavatar-bridge.js")
        self.assertIn("else Avatar3D.idle(dt);", bridge)

    def test_playback_is_armed_only_once_the_whole_sentence_is_built(self):
        """Half a sentence is not a shorter sentence, it is a wrong one."""
        bridge = read("signavatar-bridge.js")
        play = bridge[bridge.index("async function playTokens"):]
        play = play[: play.index("\n}\n")]
        self.assertLess(play.index("const built = await prepare(tokens)"), play.index("playing = true"))
        self.assertIn("if (!built?.frames?.length)", play)

    def test_the_play_button_means_the_sentence_not_whatever_is_loaded(self):
        """Playing one word card replaces what is loaded with that one word.

        Reading the loaded sequence back was the bug: the button then
        replayed that single word for ever and the sentence was gone. The
        sentence is kept separately, and the button targets it.
        """
        bridge = read("signavatar-bridge.js")
        self.assertIn("let sentenceTokens = [];", bridge)
        self.assertIn("let composedTokens = [];", bridge)
        self.assertIn("sentenceTokens = [...tokens];", bridge)
        whole = bridge[bridge.index("async function playWholeSentence"):]
        whole = whole[: whole.index("\n}\n")]
        self.assertIn("const tokens = currentSentence();", whole)
        # already loaded → replay without refetching; otherwise rebuild it
        self.assertIn("sameTokens(composedTokens, tokens)", whole)
        self.assertIn("await playTokens(tokens", whole)

    def test_the_sentence_button_is_not_disabled_while_something_plays(self):
        """It was dead for the 850ms after a word card was clicked, which is
        exactly when someone reaches for it."""
        script = read("script.js")
        self.assertIn("startPlaybackButton.disabled = !hasTokens;", script)
        self.assertNotIn("startPlaybackButton.disabled = !hasTokens || playing;", script)

    def test_the_button_is_labelled_for_what_it_does(self):
        # script.js rewrites the label on every state change, so the markup
        # and the script have to agree or the rename lasts one render
        self.assertIn("<span>整句播放</span>", read("index.html"))
        self.assertIn("\\u6574\\u53e5\\u64ad\\u653e", read("script.js"))

    def test_a_superseded_build_is_dropped_rather_than_played_late(self):
        bridge = read("signavatar-bridge.js")
        self.assertIn("if (mine !== buildToken) return null;", bridge)


class TimelineTests(unittest.TestCase):
    def test_the_dock_is_an_overlay_so_the_page_cannot_start_scrolling(self):
        """The generation page is sized to exactly one viewport. A bar in the
        normal flow would push past it; an overlay costs no layout height."""
        css = read("style.css")
        dock = css[css.index(".stage-dock{"):]
        dock = dock[: dock.index("}")]
        self.assertIn("position:absolute", dock)

    def test_the_bar_is_divided_into_words(self):
        bridge = read("signavatar-bridge.js")
        self.assertIn("function segments()", bridge)
        self.assertIn("timeline-seg", bridge)
        self.assertIn('block.dataset.start', bridge)

    def test_seeking_holds_on_the_frame_it_lands_on(self):
        bridge = read("signavatar-bridge.js")
        stop = bridge[bridge.index("const stop = e =>"):]
        stop = stop[: stop.index("};")]
        self.assertIn("paused = true;", stop)
        self.assertNotIn("playing = true;", stop)

    def test_the_bar_is_reachable_from_the_keyboard(self):
        bridge = read("signavatar-bridge.js")
        self.assertIn('role="slider"', bridge)
        self.assertIn('tabindex="0"', bridge)
        self.assertIn("ArrowLeft", bridge)


class ArmSteadinessTests(unittest.TestCase):
    def test_the_rest_pole_is_not_parallel_to_the_arm(self):
        """THE end-of-sentence tremor.

        A pole pointing the same way as shoulder→wrist defines no elbow
        plane, so the elbow was placed from rounding noise and replaced from
        different noise every frame. Measured over the final rest hold, where
        the input frames are identical: the elbow swept 188 degrees around
        the arm axis with the old pole, and 6 with this one.
        """
        avatar = read("avatar3d.js")
        self.assertIn("function restPole(side, reach)", avatar)
        self.assertIn("pole.lerp(restPole(side, maxReach * 0.5), restW)", avatar)
        self.assertNotIn("pole.lerp(restReach(side, maxReach * 0.5), restW)", avatar)
        rest_pole = avatar[avatar.index("function restPole(side, reach)"):]
        rest_pole = rest_pole[: rest_pole.index("\n}")]
        self.assertIn("REST_POLE_BACK", rest_pole)

    def test_the_elbow_plane_is_tested_relatively_and_carried_between_frames(self):
        avatar = read("avatar3d.js")
        self.assertIn("POLE_MIN_FRACTION * poleLen", avatar)
        self.assertIn("arm.bendDir", avatar)
        self.assertIn("arm.bendDir = null;", avatar)   # cleared with the rest of the state

    def test_the_stroke_amplifier_is_off_at_rest(self):
        """There is no stroke to enlarge in a placed pose, and amplifying the
        long travel down to the hip threw the settled arm past it."""
        self.assertIn("rel.add(swing.multiplyScalar(1 - restW));", read("avatar3d.js"))

    def test_the_humeral_roll_solve_has_hysteresis(self):
        avatar = read("avatar3d.js")
        self.assertIn("ROLL_TRACK_ENTER", avatar)
        self.assertIn("ROLL_TRACK_LEAVE", avatar)
        enter = float(re.search(r"ROLL_TRACK_ENTER = ([0-9.]+)", avatar).group(1))
        leave = float(re.search(r"ROLL_TRACK_LEAVE = ([0-9.]+)", avatar).group(1))
        self.assertLess(enter, leave, "a single threshold is not hysteresis")


class LoadingIconTests(unittest.TestCase):
    def test_the_hand_is_one_silhouette(self):
        """The fingers must stay attached to the palm: they are drawn before
        it and rooted below the knuckle line, so the palm covers their bases.
        The old icon folded fingers by scaling them to stubs, which broke the
        hand into five floating pieces on every beat."""
        bridge = read("signavatar-bridge.js")
        hand = bridge[bridge.index("const HAND_SVG"): bridge.index("let loadingEl")]
        self.assertLess(hand.index('class="fg f1"'), hand.index('class="palm"'))
        self.assertNotIn("scaleY", read("style.css"))

    def test_both_waits_are_covered_by_the_overlay(self):
        bridge = read("signavatar-bridge.js")
        self.assertIn('beginLoading("gloss"', bridge)
        self.assertIn('withLoading("clips"', bridge)
        self.assertIn("setLoadingProgress", bridge)


if __name__ == "__main__":
    unittest.main()
