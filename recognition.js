// ── 手語辨識頁：MediaPipe 關鍵點抽取（階段 3）──
// 模型載入、特徵抽取、骨架繪製都在共用核心 capture-core.js（與錄製工具同一份）。
// 這裡只負責辨識頁的接線：攝影機與上傳影片共用 #previewVideo，
// 偵測迴圈把特徵存進 buffer，階段 5 推論從 window.SignCapture 取序列。

import {
  FEATURE_VERSION, FEATURE_DIMS, EXPORT_FPS, DETECT_MIN_MS,
  loadLandmarkers, loadPoseLandmarker, extractFeature, drawOverlay, resample,
} from "./capture-core.js";

const BUFFER_MAX = 1500; // 約 60 秒
const K42_BUFFER_MAX = 5600; // 約 180 秒（辨識服務的影片上限）

const video  = document.querySelector("#previewVideo");
const canvas = document.querySelector("#landmarkCanvas");
const badge  = document.querySelector("#handsBadge");
const ctx    = canvas.getContext("2d");

let lm = null; // { handLandmarker, faceLandmarker, faceContours }
let poseLm = null; // Knee42 特徵需要 33 點身體姿態
let running     = false;
let lastDetect  = -1;
let lastBadgeKey = "";

const frameBuffer = []; // { t: ms, hands: 手數, face: 是否有臉, f: Float32Array(178) }

/* ── Knee42 辨識幀（送學校電腦的 42 句模型）──
   與 frameBuffer 是兩套：那邊是自家 v2 特徵（手＋blendshape，正規化過），
   這邊照 Knee42 web 頁的慣例送「原始、未鏡像」的 Tasks API 座標，
   handedness 原樣保留——訓練特徵快取就是這個分布，前端翻轉或交換左右
   會讓推論落在跟訓練不同的分布上。 */
const k42Buffer = []; // { timestamp: 秒, pose: {landmarks:[[x,y,z]…]}|null, hands: [{handedness, landmarks}] }
let k42T0 = performance.now();
let lastUploadTime = -1; // 上傳影片：rAF 比影片 fps 快，同一格不重複入列

const round5 = n => +n.toFixed(5);

function pushK42Frame(handResult, poseResult) {
  // 攝影機用 session 相對時間；上傳影片用影片自己的時間軸（可拖動、掉格也對得上）
  let timestamp;
  if (video.srcObject) {
    timestamp = (performance.now() - k42T0) / 1000;
  } else {
    if (video.currentTime === lastUploadTime) return;
    lastUploadTime = video.currentTime;
    timestamp = video.currentTime;
  }
  const hands = (handResult.landmarks || []).map((lmList, i) => ({
    handedness: handResult.handednesses?.[i]?.[0]?.categoryName || "Right",
    landmarks: lmList.map(p => [round5(p.x), round5(p.y), round5(p.z)]),
  }));
  const poseLmList = poseResult?.landmarks?.[0];
  const pose = poseLmList
    ? { landmarks: poseLmList.map(p => [round5(p.x), round5(p.y), round5(p.z)]) }
    : null;
  // 靜止（沒手）的幀也要送：伺服器端狀態機靠它校準靜止基準、判斷起訖
  k42Buffer.push({ timestamp: +timestamp.toFixed(4), pose, hands });
  if (k42Buffer.length > K42_BUFFER_MAX) k42Buffer.splice(0, k42Buffer.length - K42_BUFFER_MAX);
}

function setBadge(text, state = "idle") {
  badge.hidden = false;
  badge.textContent = text;
  badge.dataset.state = state;
}

// ── 模型載入（首次進辨識頁才載，避免拖慢首頁） ──
async function ensureLandmarker() {
  if (lm) return;
  setBadge("手部與臉部偵測模型載入中…", "loading");
  try {
    [lm, poseLm] = await Promise.all([loadLandmarkers(), loadPoseLandmarker()]);
    setBadge("偵測就緒，等待影像");
  } catch (err) {
    setBadge("模型載入失敗，請檢查網路後重試", "error");
    throw err;
  }
}

// ── 偵測迴圈 ──
function loop() {
  if (!running) return;
  const now = performance.now();
  const hasFrame = video.readyState >= 2 && video.videoWidth > 0;
  if (lm && hasFrame && !video.paused && !video.ended && now - lastDetect >= DETECT_MIN_MS) {
    const handResult = lm.handLandmarker.detectForVideo(video, now);
    const faceResult = lm.faceLandmarker.detectForVideo(video, now);
    const poseResult = poseLm ? poseLm.detectForVideo(video, Math.round(now)) : null;
    lastDetect = now;

    pushK42Frame(handResult, poseResult);
    drawOverlay(canvas, video, handResult.landmarks, faceResult.faceLandmarks, lm.faceContours);
    const count   = handResult.landmarks.length;
    const hasFace = Boolean(faceResult.faceBlendshapes?.length);
    if (count > 0 || hasFace) {
      frameBuffer.push({ t: now, hands: count, face: hasFace, f: extractFeature(handResult, faceResult) });
      if (frameBuffer.length > BUFFER_MAX) frameBuffer.splice(0, frameBuffer.length - BUFFER_MAX);
    }
    const badgeKey = `${count}-${hasFace}`;
    if (badgeKey !== lastBadgeKey) {
      lastBadgeKey = badgeKey;
      const parts = [count > 0 ? `偵測到 ${count} 隻手` : "未偵測到手", hasFace ? "臉部 ✓" : "臉部 —"];
      setBadge(parts.join("・"), count > 0 || hasFace ? "active" : "idle");
    }
  }
  requestAnimationFrame(loop);
}

function isRecognitionPageVisible() {
  return !document.querySelector("#recognition").hidden;
}

async function maybeStart() {
  if (!isRecognitionPageVisible() || video.hidden) return;
  try { await ensureLandmarker(); } catch { return; }
  canvas.hidden = false;
  lastBadgeKey = "";
  if (!running) {
    running = true;
    requestAnimationFrame(loop);
  }
}

function stopLoop({ clear = false } = {}) {
  running = false;
  if (clear) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
    badge.hidden = true;
    frameBuffer.length = 0;
    k42Buffer.length = 0;
    lastBadgeKey = "";
  }
}

// ── 事件接線（不動 script.js：靠 video 事件與 pagechange） ──
video.addEventListener("play", maybeStart);
video.addEventListener("loadeddata", maybeStart);
video.addEventListener("emptied", () => stopLoop({ clear: true })); // 重置／清除來源

window.addEventListener("pagechange", e => {
  if (e.detail === "recognition") {
    ensureLandmarker().catch(() => {});
    maybeStart();
  } else {
    stopLoop();
  }
});

if (location.hash === "#recognition") ensureLandmarker().catch(() => {});

// ── 對外 API：script.js 的辨識流程從這裡取 Knee42 幀 ──
window.Knee42Capture = {
  isReady: () => Boolean(lm && poseLm),
  frameCount: () => k42Buffer.length,
  // 開始一輪辨識：清掉舊幀、時間歸零（攝影機串流的 timestamp 從這裡起算）
  beginSession() {
    k42Buffer.length = 0;
    lastUploadTime = -1;
    k42T0 = performance.now();
  },
  // 取走目前累積的幀（取走即清空；串流模式每 400ms 拿一次）
  drainFrames() {
    return k42Buffer.splice(0, k42Buffer.length);
  },
};

// ── 對外 API：階段 5 推論從這裡取序列 ──
window.SignCapture = {
  featureVersion: FEATURE_VERSION,
  dims: FEATURE_DIMS,
  isReady: () => Boolean(lm),
  frameCount: () => frameBuffer.length,
  clear() { frameBuffer.length = 0; },
  // 匯出目前 buffer，重取樣為固定 fps，供訓練資料或推論輸入
  exportSequence(fps = EXPORT_FPS) {
    return resample(frameBuffer, fps);
  },
};
