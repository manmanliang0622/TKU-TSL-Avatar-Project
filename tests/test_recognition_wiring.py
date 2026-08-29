"""手語辨識（Knee42）串接的原始碼契約。

辨識模型跑在學校電腦（獨立 repo、獨立 venv），前端只送骨架座標。
這裡守住三件容易被改壞的事：
1. 前端送的是「原始、未鏡像」的 Tasks API 座標——訓練特徵快取就是這個
   分布，前端翻轉或交換左右會讓推論落在跟訓練不同的分布上。
2. 兩層白名單（Pages Function 與 bundle_server）必須一致，而且都不含
   /analyze_url 這類會對外連線的端點。
3. 假資料已經退場：辨識結果只能來自 /recognize/*，連不上就明講，
   不能悄悄換回內建樣本。
"""

from pathlib import Path
import re
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (PROJECT_ROOT / name).read_text(encoding="utf-8")


class RawLandmarkContractTests(unittest.TestCase):
    def test_frames_carry_raw_unflipped_coordinates(self):
        """pushK42Frame 只做四捨五入，不做任何鏡像或左右交換。"""
        recognition = read("recognition.js")
        push = recognition[recognition.index("function pushK42Frame") :]
        push = push[: push.index("\n}")]
        self.assertIn("categoryName", push)  # handedness 原樣轉送
        self.assertNotIn("1 -", push)        # 沒有 1 - p.x 之類的翻轉
        self.assertNotIn("mirror", push.lower())

    def test_rest_frames_are_still_sent(self):
        """靜止（沒手）的幀也要入列：伺服器端狀態機靠它校準與判斷起訖。

        自家 v2 特徵的 frameBuffer 只在有手或有臉時入列，Knee42 幀不能
        比照辦理——比照了，自動偵測永遠校準不完。
        """
        recognition = read("recognition.js")
        push = recognition[recognition.index("function pushK42Frame") :]
        push = push[: push.index("\n}")]
        self.assertNotIn("count", push)
        self.assertNotIn("hasFace", push)

    def test_pose_landmarker_is_loaded_for_recognition(self):
        core = read("capture-core.js")
        self.assertIn("pose_landmarker_lite", core)
        self.assertIn("export function loadPoseLandmarker", core)
        recognition = read("recognition.js")
        self.assertIn("loadPoseLandmarker", recognition)


class WhitelistAgreementTests(unittest.TestCase):
    EXPECTED = {"predict", "stream", "health", "labels"}

    def test_bundle_server_whitelist(self):
        bundle = read("bundle_server.py")
        routes = set(re.findall(r'"/recognize/(\w+)"', bundle))
        # /analyze_url 會 shell 出 yt-dlp 對外抓影片，絕不代轉
        self.assertEqual(routes, self.EXPECTED)

    def test_pages_function_whitelist(self):
        function = read("functions/api/[[path]].js")
        block = function[function.index("RECOGNIZE_ROUTES = {") :]
        block = block[: block.index("};")]
        routes = set(re.findall(r"^\s*(\w+):", block, re.MULTILINE))
        self.assertEqual(routes, self.EXPECTED)


class RecognitionFlowTests(unittest.TestCase):
    def test_the_fake_recognizer_is_gone(self):
        script = read("script.js")
        self.assertNotIn("simulateRecognition", script)
        self.assertNotIn("recognitionSamples", script)

    def test_camera_streams_and_upload_predicts(self):
        script = read("script.js")
        self.assertIn('recApi("stream")', script)
        self.assertIn('recApi("predict")', script)
        # 第一包帶 reset，伺服器才會重建這個 session 的狀態機
        self.assertIn("reset: first", script)

    def test_low_confidence_is_said_out_loud(self):
        """42 句是封閉集合，遇到詞表外的手語一定會亂答——
        信心不足時要標出來，不能裝作答對。"""
        script = read("script.js")
        self.assertIn("prob < 0.5", script)
        self.assertIn("信心不足", script)

    def test_a_dead_recognizer_is_reported_not_faked(self):
        script = read("script.js")
        self.assertIn("start_knee42.sh", script)

    def test_recognition_scripts_share_one_cache_version(self):
        """script.js 與 recognition.js 一起出貨，?v= 必須一致
        （與 avatar 三劍客同一條規矩，理由見 test_avatar_framing）。"""
        html = read("index.html")
        versions = {
            script: re.findall(rf'src="{re.escape(script)}\?v=([^"]+)"', html)
            for script in ("script.js", "recognition.js")
        }
        flat = {tag for tags in versions.values() for tag in tags}
        self.assertTrue(all(versions.values()), f"missing versioned tags: {versions}")
        self.assertEqual(len(flat), 1, f"cache tags disagree: {versions}")


class LifecycleScriptTests(unittest.TestCase):
    def test_start_script_matches_0813_conventions(self):
        text = read("start_knee42.sh")
        self.assertIn("flock", text)
        self.assertIn("kill -0", text)
        self.assertIn("webservice.server", text)
        self.assertIn("--host 127.0.0.1", text)  # 只綁 loopback，經 proxy 才出得去
        self.assertIn("8642", text)
        self.assertIn("curl -sSk", text)         # 自簽憑證，-k 是預期行為
        self.assertIn("/health", text)

    def test_stop_script_validates_process_ownership(self):
        text = read("stop_knee42.sh")
        self.assertIn("/proc/", text)
        self.assertIn("cmdline", text)
        self.assertIn("webservice.server", text)
        self.assertNotIn("pkill -f", text)


if __name__ == "__main__":
    unittest.main()
