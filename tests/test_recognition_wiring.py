"""手語辨識（Knee42）串接的原始碼契約。

辨識模型跑在學校電腦（~/knee42，獨立 venv），前端只送骨架座標。頁面接線在
knee42-client.js，script.js 只負責把「開始辨識」交給 window.Knee42。
這裡守住幾件容易被改壞的事：
1. 前端送的是「原始、未鏡像」的 Tasks API 座標——訓練特徵快取就是這個
   分布，前端翻轉或交換左右會讓推論落在跟訓練不同的分布上。
2. 前端打的路徑、Pages Function 與 bundle_server 的白名單必須一致，而且都
   不含 /analyze_url 這類會對外連線的端點。
3. 假資料已經退場：辨識結果只能來自 /knee42/*。模組沒載入、後端連不上都要
   明講，不能悄悄換回內建樣本。
4. 網路抖一下不是後端壞掉：回應不是 JSON 也要接得住、重送，不能一個請求
   失敗就把整段辨識停掉（2026-09-14 20:20 就是這樣停的）。
"""

from pathlib import Path
import re
import unittest


PROJECT_ROOT = Path(__file__).resolve().parents[1]


def read(name):
    return (PROJECT_ROOT / name).read_text(encoding="utf-8")


def js_function(source, signature):
    """取出最外層函式的原始碼：從宣告那一行到第一個頂格的右大括號。"""
    start = source.index(signature)
    return source[start : source.index("\n}", start) + 2]


class RawLandmarkContractTests(unittest.TestCase):
    def test_frames_carry_raw_unflipped_coordinates(self):
        """偵測迴圈只做四捨五入，不做任何鏡像或左右交換。

        畫面上的自拍鏡像只存在 CSS（previewBox.is-camera），資料不動。
        """
        loop = js_function(read("knee42-client.js"), "function loop(")
        self.assertIn("categoryName", loop)  # handedness 原樣轉送
        self.assertNotIn("1 -", loop)        # 沒有 1 - p.x 之類的翻轉
        self.assertNotIn("mirror", loop.lower())

    def test_rest_frames_are_still_sent(self):
        """自動模式每一幀都要入列，沒手、沒身體也一樣。

        伺服器端狀態機靠靜止幀校準、判斷一句的起訖。只在有手時入列的話，
        自動偵測永遠校準不完。
        """
        loop = js_function(read("knee42-client.js"), "function loop(")
        self.assertRegex(loop, r'if \(mode === "auto"\) \{\s*autoBuf\.push\(\{ pose, hands')

    def test_landmarkers_match_the_server_mediapipe(self):
        """Pose + Hands，版本與伺服器端的 mediapipe 對齊，不可自行升版。"""
        client = read("knee42-client.js")
        self.assertIn('const MP_VERSION = "0.10.35"', client)
        self.assertIn("pose_landmarker_lite", client)
        self.assertIn("PoseLandmarker.createFromOptions", client)
        self.assertIn("HandLandmarker.createFromOptions", client)


class WhitelistAgreementTests(unittest.TestCase):
    EXPECTED = {"predict", "stream", "health", "labels"}

    def test_pages_function_whitelist(self):
        function = read("functions/api/[[path]].js")
        block = function[function.index("KNEE42_ROUTES = {") :]
        block = block[: block.index("};")]
        routes = set(re.findall(r"^\s*(\w+):", block, re.MULTILINE))
        # /analyze_url 會 shell 出 yt-dlp 對外抓影片，絕不代轉
        self.assertEqual(routes, self.EXPECTED)

    def test_client_only_calls_whitelisted_routes(self):
        client = read("knee42-client.js")
        called = set(re.findall(r'postJson\("(\w+)"', client))
        called |= set(re.findall(r"\$\{API_BASE\}/(\w+)", client))
        self.assertTrue({"stream", "predict", "health"} <= called, called)
        self.assertLessEqual(called, self.EXPECTED)

    @unittest.skipUnless(
        "def serve_knee42" in read("bundle_server.py"),
        "repo 裡的 bundle_server.py 還是 /recognize 版；線上跑的是學校那台 "
        "~/0821/bundle_server.py 的 /knee42 版。同步進 repo 之後這條才測得到真正在跑的程式碼",
    )
    def test_bundle_server_whitelist(self):
        bundle = read("bundle_server.py")
        routes = set()
        for name in ("KNEE42_GET_ROUTES", "KNEE42_POST_ROUTES"):
            block = bundle[bundle.index(f"{name} = frozenset(") :]
            block = block[: block.index(")")]
            routes |= set(re.findall(r'"/(\w+)"', block))
        self.assertEqual(routes, self.EXPECTED)


class RecognitionFlowTests(unittest.TestCase):
    def test_the_fake_recognizer_is_gone(self):
        for name in ("script.js", "knee42-client.js"):
            source = read(name)
            self.assertNotIn("simulateRecognition", source, name)
            self.assertNotIn("recognitionSamples", source, name)

    def test_a_missing_module_is_reported_not_faked(self):
        """knee42-client.js 沒掛上 window.Knee42（檔案沒載到、執行出錯）時，
        「開始辨識」要說辨識用不了，不能跑任何會顯示「辨識完成」的東西。"""
        script = read("script.js")
        start = js_function(script, "function startRecognition(")
        self.assertIn("window.Knee42.toggle()", start)
        # 畫面上不放錯誤說明（2026-09-14 起），靠狀態列標出「無法辨識」
        self.assertIn('setRecStatus("無法辨識"', start)
        self.assertNotIn("辨識完成", start)
        # 按鈕與 Enter 鍵都走這一個入口，不各自留退路
        self.assertIn('querySelector("#startRecognition").addEventListener("click", startRecognition)', script)
        self.assertIn("if (recPage) startRecognition();", script)

    def test_script_and_client_agree_on_the_interface(self):
        """script.js 與 knee42-client.js 之間只靠 window.Knee42 這個介面接。

        兩支向來各自換 ?v=，所以不要求版號一致；真正會壞的是介面對不上。
        """
        self.assertIn("window.Knee42 = { toggle,", read("knee42-client.js"))
        self.assertIn("window.Knee42.toggle()", read("script.js"))

    def test_camera_streams_and_upload_predicts(self):
        client = read("knee42-client.js")
        self.assertIn('postJson("stream", { session: autoSession, reset, frames: chunk })', client)
        self.assertIn('postJson("predict", payload)', client)
        # 第一包帶 reset，伺服器才會重建這個 session 的狀態機；
        # 送成功才清掉，第一包失敗重送時仍然帶著
        self.assertIn("autoReset = true;", js_function(client, "function startAuto("))
        flush = js_function(client, "async function flushAuto(")
        self.assertLess(flush.index('await postJson("stream"'), flush.index("autoReset = false"))

    def test_low_confidence_is_said_out_loud(self):
        """42 句是封閉集合，遇到詞表外的手語一定會亂答——
        信心不足時要標出來，不能裝作答對。"""
        client = read("knee42-client.js")
        self.assertIn("const CONF_THRESHOLD  = 0.5;", client)
        top = js_function(client, "function renderTop(")
        self.assertIn("best.prob < CONF_THRESHOLD", top)
        self.assertIn("信心不足", top)

    def test_a_dead_backend_is_reported_not_faked(self):
        client = read("knee42-client.js")
        # 畫面上不放錯誤說明（2026-09-14 起），但狀態列與結果區仍要標出失敗，
        # 不能停在「分析中」或看起來像辨識成功
        for signature in ("async function finishManual(", "async function finishClip("):
            body = js_function(client, signature)
            self.assertIn('spoken.textContent = "辨識失敗。"', body, signature)
            self.assertIn('setStatus("連線失敗"', body, signature)
        self.assertIn('setStatus("連線失敗"', js_function(client, "async function flushAuto("))


class FlakyNetworkTests(unittest.TestCase):
    """2026-09-14 20:20：Cloudflare 轉送那一段斷了十幾秒，瀏覽器收到純文字
    「Error: Network connection lost.」，前端直接 res.json() 只丟出一句
    Unexpected token 'E'，自動模式隨即整段停掉——後端日誌裡一個失敗的請求都沒有。
    """

    def test_responses_are_parsed_defensively(self):
        client = read("knee42-client.js")
        post = js_function(client, "async function postJson(")
        self.assertIn("await res.text()", post)
        self.assertIn("JSON.parse(text)", post)
        for signature in ("async function flushAuto(", "async function postPredict("):
            self.assertNotIn(".json()", js_function(client, signature), signature)

    def test_transient_failures_are_retried_before_giving_up(self):
        client = read("knee42-client.js")
        self.assertRegex(client, r"const RETRY_DELAYS_MS = \[[\d, ]+\];")
        post = js_function(client, "async function postJson(")
        # 不是 JSON、5xx、429 算暫時性；帶 JSON 的 4xx 是資料有問題，重送沒用
        self.assertIn("!data || res.status >= 500 || res.status === 429", post)

        flush = js_function(client, "async function flushAuto(")
        self.assertIn("err.transient && autoFailures < RETRY_DELAYS_MS.length", flush)
        # 失敗的那批放回佇列最前面，伺服器端狀態機才不會缺一段
        self.assertIn("autoBuf = chunk.concat(autoBuf)", flush)

        predict = js_function(client, "async function postPredict(")
        self.assertIn("!err.transient || attempt >= RETRY_DELAYS_MS.length", predict)

    def test_pages_function_never_forwards_non_json_to_the_recognizer(self):
        function = read("functions/api/[[path]].js")
        block = function[function.index('if (route === "knee42") {\n    let text;') :]
        self.assertIn("await upstream.text()", block)
        self.assertIn("upstream returned non-JSON", block)


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
