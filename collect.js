// ── 訓練資料錄製工具（階段 4）──
// 與辨識頁共用 capture-core.js 的模型載入、特徵抽取、繪製，
// 錄出的資料保證與推論時的特徵一致（v2 = 178 維 / 25fps）。
// 資料存 localStorage，「匯出 JSON」下載後交給 Python 訓練程式。

import {
  FEATURE_VERSION, FEATURE_DIMS, EXPORT_FPS, DETECT_MIN_MS,
  loadLandmarkers, extractFeature, drawOverlay, resample,
} from "./capture-core.js";

const STORAGE_KEY    = "tsl_dataset_v2";
const COUNTDOWN_SEC  = 3;
const MAX_RECORD_MS  = 5000;
const MIN_FRAMES     = 10;   // 25fps 下約 0.4 秒，短於此視為失敗
const TARGET_PER_LABEL = 30; // 每詞建議段數（計數變綠的門檻）

const els = {
  chips:     document.querySelector("#labelChips"),
  camWrap:   document.querySelector("#camWrap"),
  video:     document.querySelector("#camVideo"),
  canvas:    document.querySelector("#camCanvas"),
  badge:     document.querySelector("#camBadge"),
  countdown: document.querySelector("#countdown"),
  camEmpty:  document.querySelector("#camEmpty"),
  camBtn:    document.querySelector("#camBtn"),
  recordBtn: document.querySelector("#recordBtn"),
  status:    document.querySelector("#statusText"),
  reviewBox: document.querySelector("#reviewBox"),
  reviewMeta:document.querySelector("#reviewMeta"),
  saveBtn:   document.querySelector("#saveBtn"),
  discardBtn:document.querySelector("#discardBtn"),
  totalCount:document.querySelector("#totalCount"),
  statList:  document.querySelector("#statList"),
  exportBtn: document.querySelector("#exportBtn"),
  clearBtn:  document.querySelector("#clearBtn"),
};

let labels = [];
let currentLabel = null;
let lm = null;              // { handLandmarker, faceLandmarker, faceContours }
let stream = null;
let running = false;
let lastDetect = -1;
let state = "idle";         // idle | counting | recording | review
let recBuffer = [];         // { t, f } 錄製中的原始幀
let recStartT = 0;
let pendingSeq = null;
let countdownTimer = null;

// ── 資料集（localStorage） ──
function loadDataset() {
  try {
    const d = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (d && d.version === FEATURE_VERSION && Array.isArray(d.clips)) return d;
  } catch (_) {}
  return { version: FEATURE_VERSION, fps: EXPORT_FPS, dims: FEATURE_DIMS, clips: [] };
}
const dataset = loadDataset();

function persistDataset() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(dataset));
    return true;
  } catch (_) {
    setStatus("⚠️ 瀏覽器儲存空間滿了——請先「匯出 JSON」備份，再清空全部後繼續錄。");
    return false;
  }
}

function countByLabel() {
  const map = {};
  for (const c of dataset.clips) map[c.label] = (map[c.label] || 0) + 1;
  return map;
}

// ── UI ──
function setStatus(text) { els.status.textContent = text; }

function setBadge(text, stateName = "idle") {
  els.badge.hidden = false;
  els.badge.textContent = text;
  els.badge.dataset.state = stateName;
}

function renderChips() {
  const counts = countByLabel();
  els.chips.innerHTML = "";
  labels.forEach(label => {
    const n = counts[label] || 0;
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip" + (label === currentLabel ? " is-active" : "") + (n >= TARGET_PER_LABEL ? " done" : "");
    btn.innerHTML = `${label}<span class="n">${n}</span>`;
    btn.addEventListener("click", () => {
      if (state === "recording" || state === "counting") return;
      currentLabel = label;
      renderChips();
      updateControls();
      setStatus(`已選「${label}」，目前 ${n} 段。開啟攝影機後即可錄製。`);
    });
    els.chips.appendChild(btn);
  });
}

function renderStats() {
  const counts = countByLabel();
  els.totalCount.textContent = dataset.clips.length;
  const entries = Object.entries(counts).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    els.statList.innerHTML = `<p class="list-empty">尚無資料</p>`;
    return;
  }
  els.statList.innerHTML = entries.map(([label, n]) =>
    `<div class="stat-row${n >= TARGET_PER_LABEL ? " ok" : ""}"><span>${label}</span><span class="count">${n} / ${TARGET_PER_LABEL}</span></div>`
  ).join("");
}

function updateControls() {
  const camOn = Boolean(stream);
  els.recordBtn.disabled = !(camOn && lm && currentLabel) || state === "review";
  els.recordBtn.textContent =
    state === "recording" ? "停止錄製" :
    state === "counting"  ? "取消倒數" : "開始錄製";
  els.camBtn.textContent = camOn ? "關閉攝影機" : "開啟攝影機";
}

// ── 攝影機 ──
async function openCamera() {
  try {
    setStatus("攝影機開啟中…");
    stream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: "user", width: { ideal: 640 } }, audio: false,
    });
  } catch (_) {
    setStatus("無法開啟攝影機，請確認權限。");
    return;
  }
  els.video.srcObject = stream;
  els.video.hidden = false;
  els.canvas.hidden = false;
  els.camEmpty.hidden = true;
  await els.video.play();

  if (!lm) {
    setBadge("偵測模型載入中…", "idle");
    try { lm = await loadLandmarkers(); }
    catch (_) { setStatus("模型載入失敗，請檢查網路後重新開啟攝影機。"); closeCamera(); return; }
  }
  setBadge("偵測就緒");
  setStatus(currentLabel ? `已選「${currentLabel}」，可以開始錄製。` : "先選一個詞彙。");
  if (!running) { running = true; requestAnimationFrame(loop); }
  updateControls();
}

function closeCamera() {
  cancelCountdown();
  if (state === "recording") { state = "idle"; }
  running = false;
  stream?.getTracks().forEach(t => t.stop());
  stream = null;
  els.video.srcObject = null;
  els.video.hidden = true;
  els.canvas.hidden = true;
  els.badge.hidden = true;
  els.camEmpty.hidden = false;
  updateControls();
}

// ── 偵測迴圈 ──
function loop() {
  if (!running) return;
  const now = performance.now();
  const hasFrame = els.video.readyState >= 2 && els.video.videoWidth > 0;
  if (lm && hasFrame && now - lastDetect >= DETECT_MIN_MS) {
    const handResult = lm.handLandmarker.detectForVideo(els.video, now);
    const faceResult = lm.faceLandmarker.detectForVideo(els.video, now);
    lastDetect = now;
    drawOverlay(els.canvas, els.video, handResult.landmarks, faceResult.faceLandmarks, lm.faceContours);

    const count   = handResult.landmarks.length;
    const hasFace = Boolean(faceResult.faceBlendshapes?.length);

    if (state === "recording") {
      recBuffer.push({ t: now, f: extractFeature(handResult, faceResult) });
      const remain = Math.max(0, (MAX_RECORD_MS - (now - recStartT)) / 1000);
      setBadge(`● 錄製中 ${remain.toFixed(1)}s`, "rec");
      if (now - recStartT >= MAX_RECORD_MS) stopRecording();
    } else if (state === "idle") {
      const parts = [count > 0 ? `偵測到 ${count} 隻手` : "未偵測到手", hasFace ? "臉部 ✓" : "臉部 —"];
      setBadge(parts.join("・"), count > 0 || hasFace ? "active" : "idle");
    }
  }
  requestAnimationFrame(loop);
}

// ── 錄製流程 ──
function startCountdown() {
  state = "counting";
  updateControls();
  let n = COUNTDOWN_SEC;
  els.countdown.hidden = false;
  els.countdown.textContent = n;
  setStatus(`準備打「${currentLabel}」…`);
  countdownTimer = setInterval(() => {
    n -= 1;
    if (n <= 0) {
      cancelCountdown(false);
      startRecording();
    } else {
      els.countdown.textContent = n;
    }
  }, 1000);
}

function cancelCountdown(resetState = true) {
  clearInterval(countdownTimer);
  countdownTimer = null;
  els.countdown.hidden = true;
  if (resetState && state === "counting") {
    state = "idle";
    updateControls();
    setStatus("已取消。");
  }
}

function startRecording() {
  recBuffer = [];
  recStartT = performance.now();
  state = "recording";
  updateControls();
  setStatus(`錄製中：請打一次「${currentLabel}」的手語（最長 ${MAX_RECORD_MS / 1000} 秒）。`);
}

function stopRecording() {
  state = "review";
  updateControls();
  // 硬性裁切到上限時長：分頁休眠會讓迴圈裡的自動停止失效，這裡保底
  const cutoff = recStartT + MAX_RECORD_MS;
  const seq = resample(recBuffer.filter(fr => fr.t <= cutoff), EXPORT_FPS);
  if (!seq || seq.frames.length < MIN_FRAMES) {
    state = "idle";
    updateControls();
    setStatus("這段太短或沒偵測到手，請重錄（確認雙手完整入鏡）。");
    return;
  }
  pendingSeq = seq;
  els.reviewBox.hidden = false;
  els.reviewMeta.textContent =
    `詞彙「${currentLabel}」・${seq.frames.length} 幀・約 ${(seq.frames.length / seq.fps).toFixed(1)} 秒・${FEATURE_DIMS} 維`;
  setStatus("檢查沒問題就儲存；打壞了就捨棄重錄。");
}

function saveClip() {
  if (!pendingSeq) return;
  dataset.clips.push({
    label: currentLabel,
    recordedAt: new Date().toISOString(),
    frames: pendingSeq.frames,
  });
  if (persistDataset()) {
    const n = countByLabel()[currentLabel];
    setStatus(`已儲存！「${currentLabel}」累計 ${n} 段。繼續下一段～`);
  }
  finishReview();
}

function discardClip() {
  setStatus("已捨棄，重新錄一段吧。");
  finishReview();
}

function finishReview() {
  pendingSeq = null;
  els.reviewBox.hidden = true;
  state = "idle";
  renderChips();
  renderStats();
  updateControls();
}

// ── 匯出／清空 ──
function exportJson() {
  if (!dataset.clips.length) { setStatus("還沒有資料可以匯出。"); return; }
  const out = { ...dataset, exportedAt: new Date().toISOString() };
  const blob = new Blob([JSON.stringify(out)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  const d = new Date().toISOString().slice(0, 10).replaceAll("-", "");
  a.download = `tsl_dataset_v${FEATURE_VERSION}_${d}.json`;
  a.click();
  URL.revokeObjectURL(a.href);
  setStatus(`已匯出 ${dataset.clips.length} 段。`);
}

let clearArmed = null;
function clearAll() {
  if (clearArmed) {
    clearTimeout(clearArmed);
    clearArmed = null;
    els.clearBtn.textContent = "清空全部";
    dataset.clips = [];
    persistDataset();
    renderChips();
    renderStats();
    setStatus("已清空。");
    return;
  }
  els.clearBtn.textContent = "確定清空？";
  clearArmed = setTimeout(() => {
    clearArmed = null;
    els.clearBtn.textContent = "清空全部";
  }, 3000);
}

// ── 事件 ──
els.camBtn.addEventListener("click", () => (stream ? closeCamera() : openCamera()));
els.recordBtn.addEventListener("click", () => {
  if (state === "recording") stopRecording();
  else if (state === "counting") cancelCountdown();
  else if (state === "idle") startCountdown();
});
els.saveBtn.addEventListener("click", saveClip);
els.discardBtn.addEventListener("click", discardClip);
els.exportBtn.addEventListener("click", exportJson);
els.clearBtn.addEventListener("click", clearAll);

document.addEventListener("keydown", e => {
  if (e.key !== " " || e.target.matches("button, input, textarea")) return;
  e.preventDefault();
  if (!els.recordBtn.disabled) els.recordBtn.click();
});

window.addEventListener("beforeunload", () => stream?.getTracks().forEach(t => t.stop()));

// ── 初始化 ──
async function init() {
  try {
    const res = await fetch("labels.json");
    labels = (await res.json()).labels;
  } catch (_) {
    setStatus("labels.json 載入失敗，請確認檔案存在。");
    return;
  }
  renderChips();
  renderStats();
  updateControls();
}
init();
