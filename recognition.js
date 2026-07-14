// ── 手語辨識：MediaPipe 關鍵點抽取管線（階段 3）──
// 攝影機與上傳影片共用 #previewVideo，這裡只負責「影像 → 關鍵點」：
// 骨架繪製、特徵序列 buffer。之後階段 4（錄製）與階段 5（推論）
// 都透過 window.SignCapture 取序列，特徵格式不可與訓練資料分岔。
//
// 特徵格式 v2：每幀 178 維 =
//   [0..125]   左手 21 點 + 右手 21 點，每點 (x,y,z)，缺手補 0；
//              每隻手以手腕(0)為原點平移，再除以「手腕→中指根部(9)」距離
//   [126..177] 臉部 52 個 blendshape 分數（眉、眼、嘴等表情語意值），缺臉補 0
//              —— 台灣手語的表情帶語法（如疑問句挑眉），用 blendshape 比 478 原始點緊湊

const MP_VERSION = "0.10.35";
const MP_BASE    = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const FACE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/face_landmarker/face_landmarker/float16/1/face_landmarker.task";

const FEATURE_VERSION = 2;
const HAND_DIMS       = 126;
const BLEND_DIMS      = 52;
const FEATURE_DIMS    = HAND_DIMS + BLEND_DIMS;
const EXPORT_FPS      = 25;
const DETECT_MIN_MS   = 33;   // 偵測頻率上限約 30fps，省電
const BUFFER_MAX      = 1500; // 約 60 秒

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];

const video  = document.querySelector("#previewVideo");
const canvas = document.querySelector("#landmarkCanvas");
const badge  = document.querySelector("#handsBadge");
const ctx    = canvas.getContext("2d");

let handLandmarker = null;
let faceLandmarker = null;
let FaceLandmarkerClass = null; // 保留 class 參照，取臉部輪廓連線常數用
let loadPromise = null;
let running     = false;
let lastDetect  = -1;
let lastBadgeKey = "";

const frameBuffer = []; // { t: ms, hands: 偵測到的手數, f: Float32Array(126) }

function setBadge(text, state = "idle") {
  badge.hidden = false;
  badge.textContent = text;
  badge.dataset.state = state;
}

// ── 模型載入（首次進辨識頁才載，避免拖慢首頁） ──
async function ensureLandmarker() {
  if (handLandmarker && faceLandmarker) return;
  loadPromise ??= (async () => {
    setBadge("手部與臉部偵測模型載入中…", "loading");
    const { FilesetResolver, HandLandmarker, FaceLandmarker } = await import(`${MP_BASE}/vision_bundle.mjs`);
    FaceLandmarkerClass = FaceLandmarker;
    const vision = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const create = delegate => Promise.all([
      HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
        runningMode: "VIDEO",
        numHands: 2,
      }),
      FaceLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: FACE_MODEL_URL, delegate },
        runningMode: "VIDEO",
        numFaces: 1,
        outputFaceBlendshapes: true,
      }),
    ]);
    try {
      [handLandmarker, faceLandmarker] = await create("GPU");
    } catch {
      [handLandmarker, faceLandmarker] = await create("CPU");
    }
    setBadge("偵測就緒，等待影像");
  })().catch(err => {
    loadPromise = null;
    setBadge("模型載入失敗，請檢查網路後重試", "error");
    throw err;
  });
  return loadPromise;
}

// ── 特徵抽取 ──
function extractFeature(handResult, faceResult) {
  const feat = new Float32Array(FEATURE_DIMS);
  handResult.landmarks.forEach((lm, i) => {
    const label = handResult.handednesses?.[i]?.[0]?.categoryName;
    const base  = label === "Left" ? 0 : 63;
    const wrist = lm[0];
    const mid   = lm[9];
    const scale = Math.hypot(mid.x - wrist.x, mid.y - wrist.y, mid.z - wrist.z) || 1;
    lm.forEach((p, j) => {
      feat[base + j * 3]     = (p.x - wrist.x) / scale;
      feat[base + j * 3 + 1] = (p.y - wrist.y) / scale;
      feat[base + j * 3 + 2] = (p.z - wrist.z) / scale;
    });
  });
  // 臉部 blendshape（模型輸出順序固定，含 _neutral 共 52 項）
  const categories = faceResult?.faceBlendshapes?.[0]?.categories;
  categories?.forEach((c, i) => {
    if (i < BLEND_DIMS) feat[HAND_DIMS + i] = c.score;
  });
  return feat;
}

// ── 繪製（video 預設 object-fit: contain，需算留邊偏移） ──
function videoContentRect() {
  const cw = canvas.clientWidth;
  const ch = canvas.clientHeight;
  const vw = video.videoWidth;
  const vh = video.videoHeight;
  if (!vw || !vh || !cw || !ch) return null;
  canvas.width = cw;
  canvas.height = ch;
  const s = Math.min(cw / vw, ch / vh);
  return { x: (cw - vw * s) / 2, y: (ch - vh * s) / 2, w: vw * s, h: vh * s };
}

function drawSkeleton(handLandmarks, faceLandmarks) {
  const r = videoContentRect();
  if (!r) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 臉部輪廓（眉、眼、唇、臉緣），畫在手部骨架底下
  const contours = FaceLandmarkerClass?.FACE_LANDMARKS_CONTOURS;
  if (contours && faceLandmarks?.length) {
    ctx.strokeStyle = "rgba(62,142,126,.75)";
    ctx.lineWidth = 1.5;
    for (const lm of faceLandmarks) {
      ctx.beginPath();
      for (const { start, end } of contours) {
        ctx.moveTo(r.x + lm[start].x * r.w, r.y + lm[start].y * r.h);
        ctx.lineTo(r.x + lm[end].x * r.w, r.y + lm[end].y * r.h);
      }
      ctx.stroke();
    }
  }

  for (const lm of handLandmarks) {
    ctx.strokeStyle = "#E2543F";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const [a, b] of HAND_CONNECTIONS) {
      ctx.moveTo(r.x + lm[a].x * r.w, r.y + lm[a].y * r.h);
      ctx.lineTo(r.x + lm[b].x * r.w, r.y + lm[b].y * r.h);
    }
    ctx.stroke();
    ctx.fillStyle = "#FFFFFF";
    for (const p of lm) {
      ctx.beginPath();
      ctx.arc(r.x + p.x * r.w, r.y + p.y * r.h, 3, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

// ── 偵測迴圈 ──
function loop() {
  if (!running) return;
  const now = performance.now();
  const hasFrame = video.readyState >= 2 && video.videoWidth > 0;
  if (handLandmarker && faceLandmarker && hasFrame && !video.paused && !video.ended && now - lastDetect >= DETECT_MIN_MS) {
    const handResult = handLandmarker.detectForVideo(video, now);
    const faceResult = faceLandmarker.detectForVideo(video, now);
    lastDetect = now;

    drawSkeleton(handResult.landmarks, faceResult.faceLandmarks);
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

// ── 對外 API：階段 4 錄製工具、階段 5 推論共用 ──
window.SignCapture = {
  featureVersion: FEATURE_VERSION,
  dims: FEATURE_DIMS,
  isReady: () => Boolean(handLandmarker && faceLandmarker),
  frameCount: () => frameBuffer.length,
  clear() { frameBuffer.length = 0; },
  // 匯出目前 buffer，重取樣為固定 fps（最近鄰），供訓練資料或推論輸入
  exportSequence(fps = EXPORT_FPS) {
    if (frameBuffer.length < 2) return null;
    const t0 = frameBuffer[0].t;
    const t1 = frameBuffer[frameBuffer.length - 1].t;
    const step = 1000 / fps;
    const frames = [];
    let idx = 0;
    for (let t = t0; t <= t1; t += step) {
      while (idx < frameBuffer.length - 1 && frameBuffer[idx + 1].t <= t) idx++;
      frames.push(Array.from(frameBuffer[idx].f));
    }
    return { version: FEATURE_VERSION, fps, dims: FEATURE_DIMS, frames };
  },
};
