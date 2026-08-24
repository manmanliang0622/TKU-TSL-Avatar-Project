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


class TokenHighlightTests(unittest.TestCase):
    """詞卡亮起與時間軸必須讀同一個時鐘。

    script.js 的 2D 佔位播放器是固定 850ms 換一個詞，時間軸是照片段實際
    長度走的。兩邊各亮各的時，整排詞卡常常在 3D 還沒動完之前就跑完了，
    使用者看到的就是「詞條跟下方時間條亮起不一致」。
    """

    def test_the_2d_placeholder_yields_the_highlight_to_the_3d_bridge(self):
        script = read("script.js")
        update = script[script.index("function updateHighlight("):]
        update = update[: update.index("\n  }")]
        self.assertIn('dataset.playback === "3d"', update)
        self.assertIn("return", update[: update.index("querySelectorAll")])

    def test_the_2d_placeholder_also_yields_the_status_text_and_the_pause_button(self):
        """同一個病的另一半：2D 跑完 850ms×n 就寫「播放完成」並把暫停鈕
        變灰，那時 3D 常常還在播。整句播放鈕維持由 2D 管，它只看有沒有
        句子可打，跟誰在播無關。"""
        script = read("script.js")
        sync = script[script.index("function syncPlaybackControls("):]
        sync = sync[: sync.index("\n}")]
        guard = sync.index('dataset.playback === "3d"')
        self.assertLess(sync.index("startPlaybackButton.disabled"), guard)
        for owned in ("pausePlaybackButton.disabled",
                      "avatarStatus.textContent",
                      "activeToken.textContent"):
            self.assertGreater(sync.index(owned), guard, owned)

    def test_the_bridge_writes_the_transport_while_it_owns_playback(self):
        bridge = read("signavatar-bridge.js")
        self.assertIn("function writeTransport(", bridge)
        self.assertIn("syncTransport(here?.token);", bridge)
        # 暫停不經過 paintTimeline，清除時主導權已交還，兩處都要自己收尾
        pause = bridge[bridge.index('pauseButton?.addEventListener'):]
        self.assertIn("syncTransport(", pause[: pause.index("\n});")])
        clear = bridge[bridge.index("function clearSequence()"):]
        self.assertIn("writeTransport(false, false, null);", clear[: clear.index("\n}")])

    def test_the_chip_and_the_timeline_block_come_from_one_lookup(self):
        """兩者都要由 paintTimeline 裡同一個 here 決定，否則又是兩個時鐘。"""
        bridge = read("signavatar-bridge.js")
        paint = bridge[bridge.index("function paintTimeline()"):]
        paint = paint[: paint.index("\n}")]
        self.assertIn("const here = currentSegments.find(", paint)
        self.assertIn("hereIndex", paint)
        self.assertIn("highlightChip(", paint)

    def test_segments_are_mapped_to_chips_by_name_not_by_index(self):
        """詞庫沒有的詞不會產生片段，段落索引與詞卡索引會錯開；
        單詞試播時整排詞卡也還在，那一段要對到使用者按的那一張。"""
        bridge = read("signavatar-bridge.js")
        self.assertIn("segChipIndex", bridge)
        self.assertIn("soloChipIndex", bridge)
        mapper = bridge[bridge.index("function mapSegmentsToChips()"):]
        mapper = mapper[: mapper.index("\n}")]
        self.assertIn("chips[i] === seg.token", mapper)
        self.assertIn("soloChipIndex", mapper)
        # 單詞試播要記下按的是哪一張；整句播放、換句子、清除都要復位，
        # 否則對照表會留在上一次單詞試播的狀態
        self.assertIn("soloChipIndex = index;", bridge)
        for name in ("async function playWholeSentence()",
                     "function clearSequence()"):
            body = bridge[bridge.index(name):]
            self.assertIn("soloChipIndex = null;", body[: body.index("\n}")], name)
        updated = bridge[bridge.index('"signavatar:generation-updated"'):]
        self.assertIn("soloChipIndex = null;", updated[: updated.index("\n});")])

    def test_the_bridge_only_claims_the_highlight_once_it_can_actually_play(self):
        """搶在組建之前的話，片段組不出來或請求整個失敗（後端沒開）就會把
        詞卡鎖死在一個永遠不會更新的主人手上，2D 也不再接手——後端一關，
        整排詞卡就再也不會亮。"""
        bridge = read("signavatar-bridge.js")
        play = bridge[bridge.index("async function playTokens("):]
        play = play[: play.index("\n}")]
        self.assertIn("claimTokenHighlight(true);", play)
        self.assertLess(play.index("composed = built;"), play.index("claimTokenHighlight(true);"))
        prepare = bridge[bridge.index("async function prepare("): bridge.index("async function playTokens(")]
        self.assertNotIn("claimTokenHighlight", prepare)
        # 清掉整句時要把詞卡還給 2D
        clear = bridge[bridge.index("function clearSequence()"):]
        self.assertIn("claimTokenHighlight(false);", clear[: clear.index("\n}")])


if __name__ == "__main__":
    unittest.main()
