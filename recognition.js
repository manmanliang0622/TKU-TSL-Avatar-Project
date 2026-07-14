// ── 手語辨識頁：MediaPipe 關鍵點抽取（階段 3）──
// 模型載入、特徵抽取、骨架繪製都在共用核心 capture-core.js（與錄製工具同一份）。
// 這裡只負責辨識頁的接線：攝影機與上傳影片共用 #previewVideo，
// 偵測迴圈把特徵存進 buffer，階段 5 推論從 window.SignCapture 取序列。

import {
  FEATURE_VERSION, FEATURE_DIMS, EXPORT_FPS, DETECT_MIN_MS,
  loadLandmarkers, extractFeature, drawOverlay, resample,
} from "./capture-core.js";

const BUFFER_MAX = 1500; // 約 60 秒

const video  = document.querySelector("#previewVideo");
const canvas = document.querySelector("#landmarkCanvas");
const badge  = document.querySelector("#handsBadge");
const ctx    = canvas.getContext("2d");

let lm = null; // { handLandmarker, faceLandmarker, faceContours }
let running     = false;
let lastDetect  = -1;
let lastBadgeKey = "";

const frameBuffer = []; // { t: ms, hands: 手數, face: 是否有臉, f: Float32Array(178) }

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
    lm = await loadLandmarkers();
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
    lastDetect = now;

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
