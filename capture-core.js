// ── 共用核心：MediaPipe 模型載入＋特徵抽取＋骨架繪製 ──
// 辨識頁（recognition.js）與訓練資料錄製工具（collect.js）都 import 這一份，
// 保證「訓練資料」與「推論輸入」的特徵計算完全一致，不會分岔。
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
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

export const FEATURE_VERSION = 2;
export const HAND_DIMS       = 126;
export const BLEND_DIMS      = 52;
export const FEATURE_DIMS    = HAND_DIMS + BLEND_DIMS;
export const EXPORT_FPS      = 25;
export const DETECT_MIN_MS   = 33; // 偵測頻率上限約 30fps，省電

const HAND_CONNECTIONS = [
  [0,1],[1,2],[2,3],[3,4],
  [0,5],[5,6],[6,7],[7,8],
  [5,9],[9,10],[10,11],[11,12],
  [9,13],[13,14],[14,15],[15,16],
  [13,17],[17,18],[18,19],[19,20],[0,17],
];

// ── 模型載入（GPU 失敗自動退 CPU；同頁只載一次） ──
// wasm 執行環境（vision bundle + FilesetResolver）各 landmarker 共用一份
let visionPromise = null;
function visionTasks() {
  visionPromise ??= (async () => {
    const module = await import(`${MP_BASE}/vision_bundle.mjs`);
    const vision = await module.FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    return { module, vision };
  })().catch(err => {
    visionPromise = null;
    throw err;
  });
  return visionPromise;
}

let loadPromise = null;
export function loadLandmarkers() {
  loadPromise ??= (async () => {
    const { module: { HandLandmarker, FaceLandmarker }, vision } = await visionTasks();
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
    let handLandmarker, faceLandmarker;
    try {
      [handLandmarker, faceLandmarker] = await create("GPU");
    } catch {
      [handLandmarker, faceLandmarker] = await create("CPU");
    }
    return { handLandmarker, faceLandmarker, faceContours: FaceLandmarker.FACE_LANDMARKS_CONTOURS };
  })().catch(err => {
    loadPromise = null;
    throw err;
  });
  return loadPromise;
}

// 身體姿態（33 點）只有辨識頁要：Knee42 模型的特徵是 pose + 雙手，
// 錄製工具（collect.js）的 v2 特徵用不到，所以獨立載入、不併進 loadLandmarkers。
// lite 版模型 5 MB 出頭，與手部模型同一套 GPU→CPU 退路。
let poseLoadPromise = null;
export function loadPoseLandmarker() {
  poseLoadPromise ??= (async () => {
    const { module: { PoseLandmarker }, vision } = await visionTasks();
    const create = delegate => PoseLandmarker.createFromOptions(vision, {
      baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
      runningMode: "VIDEO",
      numPoses: 1,
    });
    let poseLandmarker;
    try {
      poseLandmarker = await create("GPU");
    } catch {
      poseLandmarker = await create("CPU");
    }
    return poseLandmarker;
  })().catch(err => {
    poseLoadPromise = null;
    throw err;
  });
  return poseLoadPromise;
}

// ── 特徵抽取 ──
export function extractFeature(handResult, faceResult) {
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
function videoContentRect(canvas, video) {
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

export function drawOverlay(canvas, video, handLandmarks, faceLandmarks, faceContours) {
  const ctx = canvas.getContext("2d");
  const r = videoContentRect(canvas, video);
  if (!r) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  // 臉部輪廓（眉、眼、唇、臉緣），畫在手部骨架底下
  if (faceContours && faceLandmarks?.length) {
    ctx.strokeStyle = "rgba(62,142,126,.75)";
    ctx.lineWidth = 1.5;
    for (const lm of faceLandmarks) {
      ctx.beginPath();
      for (const { start, end } of faceContours) {
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

// ── 重取樣：時間戳 buffer → 固定 fps 序列（最近鄰） ──
export function resample(frameBuffer, fps = EXPORT_FPS) {
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
}
