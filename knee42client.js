// ── 手語辨識：Knee42 後端串接（取代 recognition.js 的頁面接線）──
// 特徵管線遵守 Knee42 幀層合約：MediaPipe Pose + Hands（tasks-vision 0.10.35），
// 「原始未鏡像座標 + Tasks API 原樣 handedness」直接送後端，由後端切段與分類。
// 鏡像只存在於 CSS 顯示層（previewBox.is-camera 翻轉 video 與 canvas），資料不動——
// 前端做任何翻轉或左右交換都會讓推論落在與訓練不同的分布上。
//
// 兩種輸入 → 兩條路徑：
//   即時攝影機 → POST /stream（伺服器端自動切段狀態機，每 400ms 送一批 landmark）
//   上傳影片   → 播放中逐幀抽 landmark，播完 POST /predict（整段分類，適合單句影片）
//
// 後端位址：預設同源 /knee42/*（bundle_server 轉發到 127.0.0.1:8642 的 Knee42 webservice）。
// pages.dev 等靜態部署用 localStorage.recognitionApi 或 SignAvatarConfig.recognitionApi 覆寫。

const MP_VERSION = "0.10.35"; // 與 Knee42 伺服器端 mediapipe 同版，不可自行升版
const MP_BASE    = `https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@${MP_VERSION}`;
const HAND_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/hand_landmarker/hand_landmarker/float16/1/hand_landmarker.task";
const POSE_MODEL_URL = "https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_lite/float16/1/pose_landmarker_lite.task";

// 位址優先序：localStorage 覆寫 → 設定檔指定 → 靜態部署走 /api 代理（Pages
// Function 轉發到學校主機）→ 後端自己送出的頁面走同源 /knee42。
const API_BASE = (localStorage.getItem("recognitionApi")
  || window.SignAvatarConfig?.recognitionApi
  || (window.SignAvatarConfig?.apiBase
      ? `${window.SignAvatarConfig.apiBase}/knee42`
      : `${location.origin}/knee42`)).replace(/\/$/, "");

const STREAM_FLUSH_MS = 400;   // 與 Knee42 官方測試站相同的送批節奏
const MIN_FRAMES      = 4;     // 低於此數不送 /predict
const CONF_THRESHOLD  = 0.5;   // 低於此信心視為「可能不在 42 類裡」

const HAND_EDGES = [[0,1],[1,2],[2,3],[3,4],[0,5],[5,6],[6,7],[7,8],[5,9],[9,10],
  [10,11],[11,12],[9,13],[13,14],[14,15],[15,16],[13,17],[0,17],[17,18],[18,19],[19,20]];
const POSE_EDGES = [[11,12],[11,13],[13,15],[12,14],[14,16],[11,23],[12,24],[23,24]];

const AUTO_STATE_TEXT = {
  IDLE_BLANK: "待命，可以開始比劃",
  SIGNING_ACTIVE: "偵測到動作，比劃中",
  END_CONFIRM: "確認結束中…",
  COOLDOWN: "冷卻中",
  FORCED_FINALIZE_COOLDOWN: "冷卻中",
};

// ── DOM ──
const video    = document.querySelector("#previewVideo");
const canvas   = document.querySelector("#landmarkCanvas");
const badge    = document.querySelector("#handsBadge");
const tokens   = document.querySelector("#recognitionTokens");
const spoken   = document.querySelector("#spokenResult");
const statusEl = document.querySelector("#recognitionStatus");
const message  = document.querySelector("#cameraMessage");
const startBtn = document.querySelector("#startRecognition");
const steps = [
  document.querySelector("#recognitionStep1"),
  document.querySelector("#recognitionStep2"),
  document.querySelector("#recognitionStep3"),
];
const ctx = canvas.getContext("2d");

// ── 狀態 ──
let handLm = null, poseLm = null, loadPromise = null;
let looping = false, lastVideoTime = -1, lastDetectTs = 0;
let lastBadgeKey = "";
let mode = null;                 // null | "auto"（攝影機）| "clip"（上傳影片）
let latestFrame = null;          // 偵測迴圈的最新一幀 {pose, hands}
let autoBuf = [], autoSession = "", autoT0 = 0, autoSending = false, autoTimer = null;
let clipBuf = [], clipStart = 0, clipBusy = false;

function setStatus(text, state = "idle") {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}
function setBadge(text, state = "idle") {
  badge.hidden = false;
  badge.textContent = text;
  badge.dataset.state = state;
}
function resetSteps() { steps.forEach(s => s.classList.remove("is-active", "is-complete")); }
function completeSteps() { steps.forEach(s => { s.classList.remove("is-active"); s.classList.add("is-complete"); }); }

// ── 模型載入（GPU 失敗退 CPU；同頁只載一次）──
function loadLandmarkers() {
  loadPromise ??= (async () => {
    setBadge("骨架偵測模型載入中…", "loading");
    const { FilesetResolver, HandLandmarker, PoseLandmarker } =
      await import(`${MP_BASE}/vision_bundle.mjs`);
    const vision = await FilesetResolver.forVisionTasks(`${MP_BASE}/wasm`);
    const make = async delegate => [
      await HandLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: HAND_MODEL_URL, delegate },
        runningMode: "VIDEO", numHands: 2 }),
      await PoseLandmarker.createFromOptions(vision, {
        baseOptions: { modelAssetPath: POSE_MODEL_URL, delegate },
        runningMode: "VIDEO", numPoses: 1 }),
    ];
    try { [handLm, poseLm] = await make("GPU"); }
    catch { [handLm, poseLm] = await make("CPU"); }
    setBadge("偵測就緒，等待影像");
  })().catch(err => {
    loadPromise = null;
    setBadge("模型載入失敗，請檢查網路後重試", "error");
    throw err;
  });
  return loadPromise;
}

// ── 偵測迴圈：畫骨架、餵 buffer ──
function loop(now) {
  if (!looping) return;
  requestAnimationFrame(loop);
  if (!handLm || video.readyState < 2 || !video.videoWidth) return;
  if (video.paused || video.ended || video.currentTime === lastVideoTime) return;
  lastVideoTime = video.currentTime;

  const ts = Math.round(now);
  if (ts <= lastDetectTs) return;   // detectForVideo 的時間戳必須嚴格遞增
  lastDetectTs = ts;

  let hands = [], pose = null;
  try {
    const hr = handLm.detectForVideo(video, ts);
    const pr = poseLm.detectForVideo(video, ts);
    // ★ 原始未鏡像座標 + 原樣 handedness——這是訓練特徵快取的慣例，不可改。
    hands = (hr.landmarks || []).map((lms, i) => ({
      handedness: hr.handednesses?.[i]?.[0]?.categoryName || "Right",
      score: +(hr.handednesses?.[i]?.[0]?.score ?? 1).toFixed(3),
      landmarks: lms.map(p => [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]),
    }));
    pose = pr.landmarks?.[0]
      ? { landmarks: pr.landmarks[0].map(p => [+p.x.toFixed(5), +p.y.toFixed(5), +p.z.toFixed(5)]) }
      : null;
  } catch { return; }

  latestFrame = { pose, hands };
  draw(hands, pose);
  updateBadge(hands, pose);

  if (mode === "auto") {
    autoBuf.push({ pose, hands, timestamp: +((performance.now() - autoT0) / 1000).toFixed(4) });
  } else if (mode === "clip") {
    clipBuf.push({ pose, hands });
  }
}

function updateBadge(hands, pose) {
  const shoulders = Boolean(pose?.landmarks?.[11] && pose?.landmarks?.[12]);
  const key = `${hands.length}-${shoulders}`;
  if (key === lastBadgeKey) return;
  lastBadgeKey = key;
  const handText = hands.length
    ? `偵測到 ${hands.map(h => (h.handedness === "Left" ? "左" : "右")).join("+")} 手`
    : "未偵測到手";
  setBadge(`${handText}・${shoulders ? "雙肩 ✓" : "雙肩 —"}`,
    hands.length || shoulders ? "active" : "idle");
}

function draw(hands, pose) {
  if (canvas.width !== video.videoWidth || canvas.height !== video.videoHeight) {
    canvas.width = video.videoWidth;
    canvas.height = video.videoHeight;
  }
  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);
  if (pose) {
    ctx.strokeStyle = "rgba(255,180,84,.85)";
    ctx.lineWidth = 3;
    ctx.beginPath();
    for (const [a, b] of POSE_EDGES) {
      const p = pose.landmarks[a], q = pose.landmarks[b];
      if (!p || !q) continue;
      ctx.moveTo(p[0] * w, p[1] * h);
      ctx.lineTo(q[0] * w, q[1] * h);
    }
    ctx.stroke();
  }
  for (const hand of hands) {
    ctx.strokeStyle = "rgba(79,216,232,.9)";
    ctx.lineWidth = 2.5;
    ctx.beginPath();
    for (const [a, b] of HAND_EDGES) {
      const p = hand.landmarks[a], q = hand.landmarks[b];
      ctx.moveTo(p[0] * w, p[1] * h);
      ctx.lineTo(q[0] * w, q[1] * h);
    }
    ctx.stroke();
  }
}

async function startLoop() {
  try { await loadLandmarkers(); } catch { return; }
  canvas.hidden = false;
  lastBadgeKey = "";
  lastVideoTime = -1;
  if (!looping) {
    looping = true;
    requestAnimationFrame(loop);
  }
}

function stopLoop({ clear = false } = {}) {
  looping = false;
  if (clear) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    canvas.hidden = true;
    badge.hidden = true;
    lastBadgeKey = "";
  }
}

// ── 結果渲染 ──
function renderTop(top) {
  completeSteps();
  tokens.innerHTML = "";
  top.slice(0, 3).forEach((t, i) => {
    const span = document.createElement("span");
    span.className = "token" + (i === 0 ? " is-highlighted" : "");
    span.style.animationDelay = `${i * 55}ms`;
    span.textContent = `${t.text} ${(t.prob * 100).toFixed(0)}%`;
    tokens.appendChild(span);
  });
  const best = top[0];
  if (!best) {
    spoken.textContent = "未能辨識，請再試一次。";
    setStatus("辨識完成", "idle");
    return;
  }
  if (best.prob < CONF_THRESHOLD) {
    spoken.textContent = `${best.text}（信心不足 ${(best.prob * 100).toFixed(0)}%，可能不在支援的 42 句內）`;
    setStatus("信心不足", "active");
  } else {
    spoken.textContent = best.text;
    setStatus("辨識完成", "done");
  }
}

function showAnalyzing(text) {
  resetSteps();
  steps[0].classList.add("is-active");
  tokens.innerHTML = "";
  spoken.textContent = text;
  setStatus("分析中", "active");
}

// ── 自動模式（攝影機 → /stream）──
function startAuto() {
  mode = "auto";
  autoBuf = [];
  autoSession = Math.random().toString(36).slice(2) + Date.now().toString(36);
  autoT0 = performance.now();
  showAnalyzing("自動偵測中：雙手垂放身側站好，校準完成後直接比劃。");
  setStatus("校準中", "active");
  startBtn.textContent = "停止辨識";
  message.textContent = "自動模式：比完一句把手放回身側，系統會自動切段並辨識，不必按鍵。";
  flushAuto(true);
  autoTimer = setInterval(() => flushAuto(), STREAM_FLUSH_MS);
}

async function flushAuto(reset = false) {
  if (autoSending || mode !== "auto") return;
  if (!reset && !autoBuf.length) return;
  const chunk = autoBuf;
  autoBuf = [];
  autoSending = true;
  try {
    const res = await fetch(`${API_BASE}/stream`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ session: autoSession, reset, frames: chunk }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || `HTTP ${res.status}`);
    if (mode !== "auto") return;
    if (!data.calibrated) setStatus("校準中，請站好不要動", "active");
    else setStatus(AUTO_STATE_TEXT[data.state] || data.state, "active");
    (data.results || []).forEach(seg => {
      if (seg.top?.length) {
        renderTop(seg.top);
        message.textContent = `第 ${seg.index} 句（${seg.frames} 幀）辨識完成，可以繼續比下一句。`;
      }
    });
  } catch (err) {
    stopAuto();
    setStatus("連線失敗", "idle");
    message.textContent = `辨識後端連線失敗：${err.message}。請確認後端狀態後重試。`;
  } finally {
    autoSending = false;
  }
}

function stopAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  if (mode === "auto") mode = null;
  startBtn.textContent = "開始辨識";
}

// ── 影片模式（上傳影片 → 播放抽幀 → /predict）──
async function startClip() {
  mode = "clip";
  clipBuf = [];
  clipStart = performance.now();
  showAnalyzing("影片分析中：正在逐幀抽取骨架…");
  startBtn.textContent = "取消辨識";
  message.textContent = "正在播放並分析影片。建議一支影片只含一句手語，多句會混在一起。";
  video.currentTime = 0;
  try { await video.play(); } catch {
    stopClip();
    message.textContent = "無法播放影片，請重新載入檔案。";
  }
}

async function finishClip() {
  if (mode !== "clip" || clipBusy) return;
  const frames = clipBuf;
  const duration = (performance.now() - clipStart) / 1000;
  const withPose = frames.filter(f => f.pose).length;
  if (frames.length < MIN_FRAMES || withPose < MIN_FRAMES) {
    stopClip();
    spoken.textContent = "有效幀太少，無法辨識。";
    setStatus("等待輸入", "idle");
    message.textContent = `只取到 ${frames.length} 幀（${withPose} 幀有偵測到身體）。請確認影片中上半身完整入鏡。`;
    return;
  }
  clipBusy = true;
  steps[0].classList.replace("is-active", "is-complete");
  steps[1].classList.add("is-active");
  spoken.textContent = "辨識中，請稍候…";
  try {
    const res = await fetch(`${API_BASE}/predict`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        frames,
        fps: +(frames.length / Math.max(duration, 1e-3)).toFixed(2),
        duration: +duration.toFixed(3),
      }),
    });
    const data = await res.json();
    if (!data.ok) throw new Error(data.message || `HTTP ${res.status}`);
    // 整段結果優先：單句影片常切不出段落，whole 才是答案（見 analyze_frames docstring）
    const top = data.whole?.top || data.segments?.[0]?.top || [];
    if (!top.length) {
      spoken.textContent = "未能辨識。";
      setStatus("等待輸入", "idle");
      message.textContent = data.message || "影片中偵測不到足夠的骨架，請確認上半身完整入鏡。";
      return;
    }
    renderTop(top);
    const segNote = (data.segments?.length || 0) > 1
      ? `偵測到 ${data.segments.length} 段動作，顯示整段綜合結果。`
      : "";
    message.textContent = `影片辨識完成（送出 ${data.n_frames} 幀，有效 ${data.n_valid} 幀）。${segNote}`;
  } catch (err) {
    spoken.textContent = "辨識失敗。";
    setStatus("連線失敗", "idle");
    message.textContent = `辨識後端連線失敗：${err.message}。`;
  } finally {
    clipBusy = false;
    stopClip();
  }
}

function stopClip() {
  if (mode === "clip") mode = null;
  startBtn.textContent = "開始辨識";
}

function stopAll() {
  stopAuto();
  stopClip();
}

// ── 對外入口：script.js 的「開始辨識」與 Enter 鍵委派到這裡 ──
function toggle() {
  if (mode) {         // 進行中 → 停止/取消
    const wasAuto = mode === "auto";
    stopAll();
    setStatus(wasAuto ? "已停止" : "已取消", "idle");
    if (!wasAuto) video.pause();
    return;
  }
  const isCamera = Boolean(video.srcObject);
  const isClip   = Boolean(video.getAttribute("src"));
  if (!isCamera && !isClip) {
    setStatus("等待輸入", "idle");
    message.textContent = "請先點擊上方新增手語影片，或切換到即時攝影機。";
    return;
  }
  loadLandmarkers()
    .then(() => startLoop())
    .then(() => (isCamera ? startAuto() : startClip()))
    .catch(() => {
      setStatus("等待輸入", "idle");
      message.textContent = "骨架偵測模型載入失敗，請檢查網路後重試。";
    });
}

window.Knee42 = { toggle, active: () => mode !== null };

// ── 事件接線 ──
video.addEventListener("play", () => { if (isPageVisible()) startLoop(); });
video.addEventListener("loadeddata", () => { if (isPageVisible()) startLoop(); });
video.addEventListener("ended", () => { if (mode === "clip") finishClip(); });
video.addEventListener("emptied", () => { stopAll(); stopLoop({ clear: true }); });

document.querySelector("#resetRecognition")?.addEventListener("click", () => {
  stopAll();
});

function isPageVisible() {
  return !document.querySelector("#recognition").hidden;
}

window.addEventListener("pagechange", e => {
  if (e.detail === "recognition") {
    loadLandmarkers().catch(() => {});
    checkBackend();
    if (!video.paused && !video.ended) startLoop();
  } else {
    stopAll();
    stopLoop();
  }
});

// ── 後端健康檢查：只在異常時提示 ──
let backendChecked = false;
async function checkBackend() {
  if (backendChecked) return;
  backendChecked = true;
  try {
    const res = await fetch(`${API_BASE}/health`);
    const data = await res.json();
    if (!data.ok) throw new Error("not ok");
    console.info(`[knee42] 辨識後端已連線：${data.model}（${data.classes} 類）`);
  } catch {
    message.textContent = "提醒：手語辨識後端目前未連線，開始辨識前請先確認伺服器狀態。";
  }
}

if (location.hash === "#recognition") {
  loadLandmarkers().catch(() => {});
  checkBackend();
}
