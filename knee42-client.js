// ── 手語辨識：Knee42 後端串接（取代 recognition.js 的頁面接線）──
// 特徵管線遵守 Knee42 幀層合約：MediaPipe Pose + Hands（tasks-vision 0.10.35），
// 「原始未鏡像座標 + Tasks API 原樣 handedness」直接送後端，由後端切段與分類。
// 鏡像只存在於 CSS 顯示層（previewBox.is-camera 翻轉 video 與 canvas），資料不動——
// 前端做任何翻轉或左右交換都會讓推論落在與訓練不同的分布上。
//
// 兩種輸入 → 三條路徑：
//   即時攝影機（自動切段）→ POST /stream（伺服器端自動切段狀態機，每 400ms 送一批 landmark）
//   即時攝影機（手動切段）→ 空白鍵或按鈕控制一句的開始/結束，結束時整句 POST /predict
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

// 自動模式的送批節奏。手放回原位後，伺服器要湊滿 end_hold_sec（0.5 秒）的靜止幀
// 才切段；最後那一幀在前端還得等下一次送批、再走一趟往返，結果才會出現。
// 線上實測（2026-09-14）連線熱著時一趟 /stream 0.16–0.23 秒，一批 3 幀或 12 幀
// 都一樣 —— 慢的是固定 400ms 才送一次，不是資料量。所以只在比劃中改成「上一批
// 回來就送下一批」；待命、校準、冷卻時結果不會出來，維持 400ms，別白燒 Pages
// Functions 的請求額度。
const STREAM_FLUSH_MS        = 400;   // 待命／校準／冷卻，與 Knee42 官方測試站相同
const STREAM_ACTIVE_FLUSH_MS = 100;   // 比劃中、確認結束中
const STREAM_TICK_MS         = 50;
const AUTO_FAST_STATES = new Set(["SIGNING_ACTIVE", "END_CONFIRM"]);
const MIN_FRAMES      = 4;     // 低於此數不送 /predict
const CONF_THRESHOLD  = 0.5;   // 低於此信心視為「可能不在 42 類裡」
const RETRY_DELAYS_MS = [400, 1000, 2000];   // 暫時性失敗最多重送 3 次，前後約 3.4 秒

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
const segSwitch    = document.querySelector("#segModeSwitch");
const autoSegBtn   = document.querySelector("#autoSegButton");
const manualSegBtn = document.querySelector("#manualSegButton");
const segActionBtn = document.querySelector("#manualSegmentButton");
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
let mode = null;                 // null | "auto"（攝影機自動切段）| "manual"（攝影機手動切段）| "clip"（上傳影片）
let latestFrame = null;          // 偵測迴圈的最新一幀 {pose, hands}
let autoBuf = [], autoSession = "", autoT0 = 0, autoSending = false, autoTimer = null;
let autoReset = false, autoFailures = 0, autoRetryAt = 0;
let autoState = "", autoLastSent = 0, autoCalibrated = false, autoTimeouts = 0;
let clipBuf = [], clipStart = 0, clipBusy = false;
let manualBuf = [], manualT0 = 0, manualRecording = false, manualBusy = false;
// 攝影機的切段方式；上傳影片一律整段送 /predict，與此無關。
// 每次開頁一律從「手動切段」開始 —— 不從 localStorage 還原上次的選擇。
// （要改回記住上次選擇的話，換成：
//   localStorage.getItem("recognitionSegMode") === "auto" ? "auto" : "manual"）
let segMode = "manual";

// 控制台提示。#cameraMessage 平常被 .rail .console-note 裁成 1×1（只留給輔助
// 技術），掛上 data-state 才回到畫面 —— 不然攝影機沒開成、後端沒連上、這句
// 幀數不夠這些話，使用者一個字都看不到。script.js 有一份同樣的 setConsoleNote。
function note(text, state = "info") {
  message.textContent = text;
  message.dataset.state = state;
}

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
  } else if (mode === "manual" && manualRecording) {
    manualBuf.push({ pose, hands });
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

// 骨架圖層鋪滿整個舞台，影片卻是 object-fit:contain（比例不合就留黑邊）。
// 以前 canvas 用影片原始尺寸、再被 CSS 拉滿舞台，只要舞台和影片比例不同
// ——手機直向自拍鏡頭（例如 480×640）塞進 4:3 舞台——骨架就被橫向拉寬、
// 偏離人。改成 canvas 跟舞台同尺寸，座標換算到影片實際畫出來的那塊矩形。
// 不靠 canvas 上的 object-fit：WebKit（iOS Safari、LINE 內建瀏覽器）沒把握。
// 兩層都以舞台中心 scaleX(-1)，黑邊左右對稱，鏡像後依然對齊。
function draw(hands, pose) {
  const dpr = window.devicePixelRatio || 1;
  const cw = Math.round(canvas.clientWidth * dpr);
  const ch = Math.round(canvas.clientHeight * dpr);
  if (canvas.width !== cw || canvas.height !== ch) {
    canvas.width = cw;
    canvas.height = ch;
  }
  ctx.clearRect(0, 0, cw, ch);
  if (!cw || !ch) return;
  const scale = Math.min(cw / video.videoWidth, ch / video.videoHeight);
  const w = video.videoWidth * scale, h = video.videoHeight * scale;
  const ox = (cw - w) / 2, oy = (ch - h) / 2;
  const line = (p, q) => {
    ctx.moveTo(ox + p[0] * w, oy + p[1] * h);
    ctx.lineTo(ox + q[0] * w, oy + q[1] * h);
  };
  if (pose) {
    ctx.strokeStyle = "rgba(255,180,84,.85)";
    ctx.lineWidth = 3 * dpr;
    ctx.beginPath();
    for (const [a, b] of POSE_EDGES) {
      const p = pose.landmarks[a], q = pose.landmarks[b];
      if (!p || !q) continue;
      line(p, q);
    }
    ctx.stroke();
  }
  for (const hand of hands) {
    ctx.strokeStyle = "rgba(79,216,232,.9)";
    ctx.lineWidth = 2.5 * dpr;
    ctx.beginPath();
    for (const [a, b] of HAND_EDGES) line(hand.landmarks[a], hand.landmarks[b]);
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
    // 主句歸主句、附註歸附註：附註另起一行並收小字級（樣式見 .spoken-note）
    spoken.textContent = best.text;
    const note = document.createElement("span");
    note.className = "spoken-note";
    note.textContent = `（信心不足 ${(best.prob * 100).toFixed(0)}%，可能不在支援的 42 句內）`;
    spoken.appendChild(note);
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

// ── 送出與重試（/stream 與 /predict 共用）──
// 瀏覽器到學校主機要經過 Pages Function → Cloudflare → quick tunnel，任何一段
// 抖一下都會失敗：fetch 直接丟錯、502/524，或 Cloudflare 自己吐的純文字
// 「Error: Network connection lost.」（2026-09-14 20:20 抖了十幾秒，後端日誌
// 裡一個失敗的請求都沒有）。這些重送一次通常就好，連續失敗才算真的連不上。
// 帶著 JSON 的 4xx 是資料本身有問題，重送也沒用，直接回報。
class BackendError extends Error {
  constructor(message, transient) {
    super(message);
    this.transient = transient;
  }
}

async function postJson(path, payload) {
  let res, text;
  try {
    res = await fetch(`${API_BASE}/${path}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    text = await res.text();
  } catch (err) {
    throw new BackendError(`網路中斷（${err.message}）`, true);
  }
  let data = null;
  try { data = JSON.parse(text); } catch { /* 不是 JSON：代理或 Cloudflare 的錯誤頁 */ }
  if (data?.ok) return data;
  const detail = (data?.message || data?.error || text.trim().slice(0, 60)).replace(/[\s.。]+$/, "") || "沒有內容";
  throw new BackendError(`HTTP ${res.status}：${detail}`, !data || res.status >= 500 || res.status === 429);
}

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function failureNote(err) {
  return err.transient
    ? `辨識後端連線失敗（已重試 ${RETRY_DELAYS_MS.length} 次）：${err.message}`
    : `辨識後端回報錯誤：${err.message}`;
}

// ── 自動模式（攝影機 → /stream）──
function startAuto() {
  mode = "auto";
  autoBuf = [];
  autoSession = Math.random().toString(36).slice(2) + Date.now().toString(36);
  autoT0 = performance.now();
  autoReset = true;
  autoFailures = 0;
  autoRetryAt = 0;
  autoState = "";
  autoLastSent = 0;
  autoCalibrated = false;
  autoTimeouts = 0;
  showAnalyzing("自動偵測中");
  setStatus("校準中", "active");
  startBtn.textContent = "停止辨識";
  note("自動模式：先讓雙手入鏡、放在休息位置（例如大腿上）別動，校準完就可以開始比。比完一句把手放回同一個位置，系統會自動切段並辨識。");
  flushAuto();
  autoTimer = setInterval(flushAuto, STREAM_TICK_MS);
}

async function flushAuto() {
  const now = performance.now();
  if (autoSending || mode !== "auto" || now < autoRetryAt) return;
  if (!autoReset) {
    if (!autoBuf.length) return;
    const gap = AUTO_FAST_STATES.has(autoState) ? STREAM_ACTIVE_FLUSH_MS : STREAM_FLUSH_MS;
    if (now - autoLastSent < gap) return;
  }
  const chunk = autoBuf;
  const reset = autoReset;
  autoBuf = [];
  autoSending = true;
  autoLastSent = now;
  try {
    const data = await postJson("stream", { session: autoSession, reset, frames: chunk });
    autoReset = false;
    if (mode !== "auto") return;
    if (autoFailures) {
      autoFailures = 0;
      note("連線恢復，繼續自動偵測。");
    }
    autoState = data.state;
    if (!data.calibrated) {
      setStatus("校準中：雙手入鏡、放在休息位置別動", "active");
    } else {
      setStatus(AUTO_STATE_TEXT[data.state] || data.state, "active");
      if (!autoCalibrated) {
        autoCalibrated = true;
        note("校準完成，可以開始比。比完一句把手放回剛才的休息位置，結果會馬上出來。");
      }
    }
    (data.results || []).forEach(seg => {
      if (!seg.top?.length) return;
      renderTop(seg.top);
      if (seg.reason !== "timeout_finalize") {
        autoTimeouts = 0;
        note(`第 ${seg.index} 句（${seg.frames} 幀）辨識完成，可以繼續比下一句。`);
        return;
      }
      // 伺服器的靜止基準只在開始那一秒記一次、之後不再更新。手沒回到那個位置，
      // 這句就只能等到時間上限（線上設定 12 秒）才被強制切斷 —— 這是自動模式
      // 慢的主因，而且段落裡塞滿靜止幀，辨識也不準。告訴使用者怎麼避開。
      autoTimeouts++;
      const secs = seg.start != null && seg.end != null ? `${(seg.end - seg.start).toFixed(1)} 秒` : "時間";
      note(`第 ${seg.index} 句沒偵測到手回到休息位置，等到 ${secs}上限才切斷，所以比較慢。比完請把手放回開始時的位置、停半秒。`
        + (autoTimeouts >= 2 ? "連續幾句都這樣的話，按「停止辨識」再重新開始，讓系統重新記一次休息姿勢。" : ""), "warn");
    });
  } catch (err) {
    if (mode !== "auto") return;
    if (err.transient && autoFailures < RETRY_DELAYS_MS.length) {
      // 這批放回佇列最前面，跟之後的幀一起重送，伺服器端的狀態機才不會缺一段。
      // 萬一其實送到了、只是回應在路上掉了，重送會讓幾幀重複 —— 伺服器把
      // 不遞增的時間戳往後推 1ms，影響遠小於整段辨識被迫停下來。
      autoBuf = chunk.concat(autoBuf);
      autoRetryAt = performance.now() + RETRY_DELAYS_MS[autoFailures++];
      setStatus(`連線不穩，重試中（${autoFailures}/${RETRY_DELAYS_MS.length}）`, "active");
      return;
    }
    stopAuto();
    setStatus("連線失敗", "idle");
    note(`${failureNote(err)}。請確認後端狀態後重試。`, "warn");
  } finally {
    autoSending = false;
    // 比劃中不等下一個 tick，回應一到就把這段時間累積的幀送出去
    if (AUTO_FAST_STATES.has(autoState)) flushAuto();
  }
}

function stopAuto() {
  clearInterval(autoTimer);
  autoTimer = null;
  if (mode === "auto") mode = null;
  startBtn.textContent = "開始辨識";
}

// ── /predict 共用送出（手動模式與影片模式）──
// /predict 不帶狀態，整句重送不會有副作用；錄好的這一句不必因為網路抖一下就重比。
async function postPredict(frames, duration) {
  const payload = {
    frames,
    fps: +(frames.length / Math.max(duration, 1e-3)).toFixed(2),
    duration: +duration.toFixed(3),
  };
  for (let attempt = 0; ; attempt++) {
    try {
      return await postJson("predict", payload);
    } catch (err) {
      if (!err.transient || attempt >= RETRY_DELAYS_MS.length) throw err;
      setStatus(`連線不穩，重試中（${attempt + 1}/${RETRY_DELAYS_MS.length}）`, "active");
      await sleep(RETRY_DELAYS_MS[attempt]);
    }
  }
}

// ── 手動模式（攝影機 → 空白鍵/按鈕切一句 → /predict）──
function startManual() {
  mode = "manual";
  manualRecording = false;
  manualBuf = [];
  resetSteps();
  tokens.innerHTML = "";
  spoken.textContent = "尚未辨識";
  setStatus("待命", "active");
  startBtn.textContent = "停止辨識";
  if (segActionBtn) {
    segActionBtn.hidden = false;
    segActionBtn.disabled = false;
    segActionBtn.textContent = "開始這句（空白鍵）";
  }
  note("手動模式：按空白鍵或「開始這句」開始錄，比完再按一次結束並辨識。");
}

function manualToggleSegment() {
  if (mode !== "manual" || manualBusy) return;
  if (!manualRecording) {
    manualRecording = true;
    manualBuf = [];
    manualT0 = performance.now();
    showAnalyzing("錄製中");
    setStatus("錄製中", "active");
    if (segActionBtn) segActionBtn.textContent = "結束這句（空白鍵）";
    note("錄製中：比完後再按一次空白鍵（或「結束這句」）送出辨識。");
  } else {
    manualRecording = false;
    finishManual();
  }
}

function cancelManualSegment() {
  if (mode !== "manual" || !manualRecording) return;
  manualRecording = false;
  manualBuf = [];
  resetSteps();
  if (segActionBtn) segActionBtn.textContent = "開始這句（空白鍵）";
  spoken.textContent = "已取消這句。";
  setStatus("待命", "active");
  note("已取消，按空白鍵或「開始這句」重新錄製。");
}

async function finishManual() {
  const frames = manualBuf;
  manualBuf = [];
  const duration = (performance.now() - manualT0) / 1000;
  if (segActionBtn) segActionBtn.textContent = "開始這句（空白鍵）";
  const withPose = frames.filter(f => f.pose).length;
  if (frames.length < MIN_FRAMES || withPose < MIN_FRAMES) {
    spoken.textContent = "有效幀太少，無法辨識。";
    setStatus("待命", "active");
    note(`這句只錄到 ${frames.length} 幀（${withPose} 幀有偵測到身體）。請確認上半身完整入鏡後重錄一次。`, "warn");
    return;
  }
  manualBusy = true;
  if (segActionBtn) segActionBtn.disabled = true;
  steps[0].classList.replace("is-active", "is-complete");
  steps[1].classList.add("is-active");
  spoken.textContent = "辨識中，請稍候…";
  try {
    const data = await postPredict(frames, duration);
    // 手動切出來的就是一句，與上傳影片相同：讀整段 whole 結果
    const top = data.whole?.top || data.segments?.[0]?.top || [];
    if (!top.length) {
      spoken.textContent = "未能辨識。";
      setStatus(mode === "manual" ? "待命" : "等待輸入", mode === "manual" ? "active" : "idle");
      note(data.message || "這句偵測不到足夠的骨架，請確認上半身完整入鏡後重錄。", "warn");
    } else {
      renderTop(top);
      note(mode === "manual"
        ? `這句辨識完成（送出 ${data.n_frames} 幀，有效 ${data.n_valid} 幀），按空白鍵繼續錄下一句。`
        : `辨識完成（送出 ${data.n_frames} 幀，有效 ${data.n_valid} 幀）。`);
    }
  } catch (err) {
    spoken.textContent = "辨識失敗。";
    setStatus("連線失敗", mode === "manual" ? "active" : "idle");
    note(`${failureNote(err)}。請確認後端狀態後重錄這一句。`, "warn");
  } finally {
    manualBusy = false;
    if (segActionBtn) segActionBtn.disabled = false;
  }
}

function stopManual() {
  manualRecording = false;
  manualBuf = [];
  if (mode === "manual") mode = null;
  if (segActionBtn) segActionBtn.hidden = true;
  startBtn.textContent = "開始辨識";
}

// ── 影片模式（上傳影片 → 播放抽幀 → /predict）──
async function startClip() {
  mode = "clip";
  clipBuf = [];
  clipStart = performance.now();
  showAnalyzing("影片分析中");
  startBtn.textContent = "取消辨識";
  note("正在播放並分析影片。建議一支影片只含一句手語，多句會混在一起。");
  video.currentTime = 0;
  try { await video.play(); } catch {
    stopClip();
    note("無法播放影片，請重新載入檔案。", "warn");
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
    note(`只取到 ${frames.length} 幀（${withPose} 幀有偵測到身體）。請確認影片中上半身完整入鏡。`, "warn");
    return;
  }
  clipBusy = true;
  steps[0].classList.replace("is-active", "is-complete");
  steps[1].classList.add("is-active");
  spoken.textContent = "辨識中，請稍候…";
  try {
    const data = await postPredict(frames, duration);
    // 整段結果優先：單句影片常切不出段落，whole 才是答案（見 analyze_frames docstring）
    const top = data.whole?.top || data.segments?.[0]?.top || [];
    if (!top.length) {
      spoken.textContent = "未能辨識。";
      setStatus("等待輸入", "idle");
      note(data.message || "影片中偵測不到足夠的骨架，請確認上半身完整入鏡。", "warn");
      return;
    }
    renderTop(top);
    const segNote = (data.segments?.length || 0) > 1
      ? `偵測到 ${data.segments.length} 段動作，顯示整段綜合結果。`
      : "";
    note(`影片辨識完成（送出 ${data.n_frames} 幀，有效 ${data.n_valid} 幀）。${segNote}`);
  } catch (err) {
    spoken.textContent = "辨識失敗。";
    setStatus("連線失敗", "idle");
    note(`${failureNote(err)}。`, "warn");
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
  stopManual();
  stopClip();
}

// ── 對外入口：script.js 的「開始辨識」與 Enter 鍵委派到這裡 ──
function toggle() {
  if (mode) {         // 進行中 → 停止/取消
    const wasClip = mode === "clip";
    stopAll();
    setStatus(wasClip ? "已取消" : "已停止", "idle");
    if (wasClip) video.pause();
    return;
  }
  const isCamera = Boolean(video.srcObject);
  const isClip   = Boolean(video.getAttribute("src"));
  if (!isCamera && !isClip) {
    setStatus("等待輸入", "idle");
    note("請先點擊上方新增手語影片，或切換到即時攝影機。", "warn");
    return;
  }
  loadLandmarkers()
    .then(() => startLoop())
    .then(() => (isCamera ? (segMode === "manual" ? startManual() : startAuto()) : startClip()))
    .catch(() => {
      setStatus("等待輸入", "idle");
      note("骨架偵測模型載入失敗，請檢查網路後重試。", "warn");
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

// ── 切段方式（自動/手動）──
function applySegChips() {
  if (!autoSegBtn || !manualSegBtn) return;
  autoSegBtn.classList.toggle("is-active", segMode === "auto");
  autoSegBtn.setAttribute("aria-pressed", String(segMode === "auto"));
  manualSegBtn.classList.toggle("is-active", segMode === "manual");
  manualSegBtn.setAttribute("aria-pressed", String(segMode === "manual"));
}

function setSegMode(next) {
  if (segMode !== next) {
    segMode = next;
    localStorage.setItem("recognitionSegMode", next);
    // 辨識進行中切換 → 直接換成另一種切段方式，攝影機不中斷
    if (mode === "auto" && next === "manual") { stopAuto(); startManual(); }
    else if (mode === "manual" && next === "auto") { stopManual(); startAuto(); }
    else if (!mode) {
      note(next === "manual"
        ? "手動切段：開始辨識後，用空白鍵或「開始這句」按鈕控制每一句的開始與結束。"
        : "自動切段：開始辨識後先讓雙手入鏡、在休息位置別動讓系統校準；比完一句把手放回同一個位置，系統會自動切段。");
    }
  }
  applySegChips();
}

autoSegBtn?.addEventListener("click", () => setSegMode("auto"));
manualSegBtn?.addEventListener("click", () => setSegMode("manual"));
segActionBtn?.addEventListener("click", manualToggleSegment);
applySegChips();

// 切段方式只對攝影機有意義；上傳影片時把切換藏起來
function updateSegSwitchVisibility() {
  if (!segSwitch) return;
  segSwitch.hidden = !video.srcObject && Boolean(video.getAttribute("src"));
}
video.addEventListener("loadeddata", updateSegSwitchVisibility);
video.addEventListener("emptied", updateSegSwitchVisibility);
document.querySelector("#videoModeButton")?.addEventListener("click", () => {
  if (segSwitch) segSwitch.hidden = true;
  // 切到上傳影片會停掉攝影機串流，進行中的攝影機辨識一併收掉
  if (mode === "auto" || mode === "manual") {
    stopAll();
    setStatus("已停止", "idle");
  }
});
document.querySelector("#cameraModeButton")?.addEventListener("click", () => { if (segSwitch) segSwitch.hidden = false; });

// 空白鍵＝手動切段的開始/結束。用 capture 搶在 script.js 與按鈕原生空白鍵行為之前，
// 避免焦點停在按鈕上時一次空白鍵觸發兩件事。
document.addEventListener("keydown", e => {
  if (e.key !== " " || e.repeat || e.metaKey || e.ctrlKey || e.altKey) return;
  if (!isPageVisible() || e.target.matches("input, textarea, select")) return;
  if (mode === "manual") {
    e.preventDefault();
    e.stopPropagation();
    manualToggleSegment();
  } else if (!mode && segMode === "manual" && video.srcObject) {
    e.preventDefault();
    e.stopPropagation();
    toggle();   // 還沒開始就按空白鍵：直接進入手動待命，再按一次開始錄
  }
}, true);

// Esc＝放棄正在錄的這一句（不送辨識）
document.addEventListener("keydown", e => {
  if (e.key !== "Escape" || !isPageVisible()) return;
  if (mode === "manual" && manualRecording) {
    e.stopPropagation();
    cancelManualSegment();
  }
}, true);

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
    note("提醒：手語辨識後端目前未連線，開始辨識前請先確認伺服器狀態。", "warn");
  }
}

if (location.hash === "#recognition") {
  loadLandmarkers().catch(() => {});
  checkBackend();
}
