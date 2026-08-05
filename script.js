// ════════════════════════════════════════════
//  手譯橋 SignBridge — Hero reveal + 雙向手語功能
// ════════════════════════════════════════════

// ── Hero Reveal Lens ──
(function () {
  const hero   = document.getElementById('home');
  const reveal = document.getElementById('reveal');
  if (!hero || !reveal) return;
  const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

  let x = 0, y = 0, tx = 0, ty = 0;
  let r = 0, tr = 0;
  const RADIUS = 235;
  let hasMoved = false;
  let idleActive = false;
  let idleT = 0;
  let heroRect = hero.getBoundingClientRect();

  function updateRect() { heroRect = hero.getBoundingClientRect(); }
  window.addEventListener('scroll', updateRect, { passive: true });

  function setInitial() {
    updateRect();
    tx = x = heroRect.width * 0.62;
    ty = y = heroRect.height * 0.58;
  }
  setInitial();
  window.addEventListener('resize', () => { updateRect(); if (!hasMoved) setInitial(); });

  const mqMobile = window.matchMedia('(max-width: 900px)');
  const touchDevice = window.matchMedia('(hover:none)').matches;
  let lastInteraction = 0;

  function moveTo(clientX, clientY) {
    tx = clientX - heroRect.left;
    ty = clientY - heroRect.top;
    tr = RADIUS;
    hasMoved = true;
    idleActive = false;
    lastInteraction = performance.now();
    // 游標在右側（圖片／對話框區）才隱藏對話框，一離開立刻顯現
    const exploring = mqMobile.matches
      ? ty > heroRect.height * 0.5
      : tx > heroRect.width * 0.48;
    hero.classList.toggle('is-exploring', exploring);
  }

  hero.addEventListener('pointermove', e => moveTo(e.clientX, e.clientY));
  hero.addEventListener('pointerdown', e => moveTo(e.clientX, e.clientY));
  hero.addEventListener('pointerleave', () => { tr = 0; hero.classList.remove('is-exploring'); });

  // gentle automatic drift before first interaction (so touch users see the magic)
  setTimeout(() => { if (!hasMoved && !reduced) idleActive = true; }, 1600);

  let rafId = null;
  function frame() {
    // 觸控裝置：放著不動 5 秒後恢復自動漫遊，透鏡效果不會就此消失
    if (touchDevice && !reduced && hasMoved && !idleActive &&
        performance.now() - lastInteraction > 5000) {
      idleActive = true;
    }
    if (idleActive) {
      idleT += 0.008;
      tx = heroRect.width  * 0.60 + Math.sin(idleT)     * heroRect.width  * 0.13;
      ty = heroRect.height * 0.55 + Math.sin(idleT * 2) * heroRect.height * 0.07;
      tr = RADIUS * 0.85;
    }
    const k = reduced ? 1 : 0.09;
    x += (tx - x) * k;
    y += (ty - y) * k;
    r += (tr - r) * (reduced ? 1 : 0.07);

    reveal.style.setProperty('--mx', x.toFixed(1) + 'px');
    reveal.style.setProperty('--my', y.toFixed(1) + 'px');
    reveal.style.setProperty('--r', Math.max(0, r).toFixed(1) + 'px');
    rafId = requestAnimationFrame(frame);
  }

  // 只在首頁可見且分頁在前景時跑動畫迴圈
  function startLoop() { if (rafId === null) rafId = requestAnimationFrame(frame); }
  function stopLoop()  { if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; } }
  function syncLoop()  { (document.hidden || hero.hidden) ? stopLoop() : startLoop(); }

  document.addEventListener('visibilitychange', syncLoop);
  window.addEventListener('pagechange', () => { syncLoop(); if (!hero.hidden) updateRect(); });
  startLoop();
})();

// ── Vocabulary Data ──
const recognitionSamples = {
  drink:    { signOrder: ["我", "水", "喝", "要"], spokenText: "我要喝水" },
  register: { signOrder: ["我", "掛號", "要"],     spokenText: "我要掛號" },
  help:     { signOrder: ["請", "我", "幫忙"],     spokenText: "請幫我一下" },
};

const generationSamples = {
  "我要喝水":  ["我", "水", "喝", "要"],
  "請幫我一下": ["請", "我", "幫忙"],
  "我要掛號":  ["我", "掛號", "要"],
  "我想回家":  ["我", "家", "回", "想"],
  "你好":     ["你", "好"],
  "早安":     ["早", "安"],
  "晚安":     ["晚", "安"],
  "謝謝":     ["謝謝"],
  "對不起":   ["對不起"],
  "再見":     ["再", "見"],
  "請問":     ["請", "問"],
  "我不舒服":  ["我", "不舒服"],
  "我頭痛":   ["我", "頭", "痛"],
  "請叫醫生":  ["請", "叫", "醫生"],
  "請幫我":   ["請", "幫", "我"],
  "我要上課":  ["我", "上課", "要"],
  "我不懂":   ["我", "不", "懂"],
  "下課了":   ["下課", "了"],
  "我要去哪裡": ["我", "哪裡", "去", "要"],
  "請停車":   ["請", "停", "車"],
  "多少錢":   ["多少", "錢"],
  "謝謝司機":  ["謝謝", "司機"],
};

const QUICK_PHRASES = ["你好", "謝謝", "我要喝水", "我要掛號", "請幫我一下", "我不舒服", "我要上課", "多少錢"];

// ── DOM refs ──
const previewVideo        = document.querySelector("#previewVideo");
const previewBox          = document.querySelector("#previewBox");
const emptyPreview        = document.querySelector("#emptyPreview");
const videoUpload         = document.querySelector("#videoUpload");
const recognitionTokens   = document.querySelector("#recognitionTokens");
const spokenResult        = document.querySelector("#spokenResult");
const recognitionStatus   = document.querySelector("#recognitionStatus");
const cameraMessage       = document.querySelector("#cameraMessage");

function setRecStatus(text, state = "idle") {
  recognitionStatus.textContent = text;
  recognitionStatus.dataset.state = state;
}
const generationTokens    = document.querySelector("#generationTokens");
const textInput           = document.querySelector("#textInput");
const originalSentence    = document.querySelector("#originalSentence");
const generationStatus    = document.querySelector("#generationStatus");
const avatarStatus        = document.querySelector("#avatarStatus");
const activeToken         = document.querySelector("#activeToken");
const avatarFigure        = document.querySelector("#avatarFigure");
const videoModeButton     = document.querySelector("#videoModeButton");
const cameraModeButton    = document.querySelector("#cameraModeButton");
const quickPhrases         = document.querySelector("#quickPhrases");
const startPlaybackButton  = document.querySelector("#startPlayback");
const pausePlaybackButton  = document.querySelector("#pausePlayback");

const recognitionSteps = [
  document.querySelector("#recognitionStep1"),
  document.querySelector("#recognitionStep2"),
  document.querySelector("#recognitionStep3"),
];

let recognitionTimer = null;
let currentStream    = null;
let currentGeneratedTokens = generationSamples["我要喝水"];
let uploadedVideoUrl = null;

// ── Page Navigation ──
const PAGES        = ["home", "recognition", "generation"];
const pageSections = document.querySelectorAll(".page-section");
const navLinks     = document.querySelectorAll(".links a");
const navHeader    = document.querySelector(".nav");
const navToggle    = document.querySelector("#navToggle");

function closeMenu() {
  navHeader.classList.remove("menu-open");
  navToggle?.setAttribute("aria-expanded", "false");
}

navToggle?.addEventListener("click", () => {
  const open = navHeader.classList.toggle("menu-open");
  navToggle.setAttribute("aria-expanded", String(open));
});

function showPage(id, push = true) {
  pageSections.forEach(s => { s.hidden = s.id !== id; });
  navLinks.forEach(a => {
    const active = a.getAttribute("href").slice(1) === id;
    a.classList.toggle("is-active", active);
    a.setAttribute("aria-current", active ? "page" : "false");
  });

  // 離開頁面時的清理：關閉攝影機、停止播放
  if (id !== "recognition" && currentStream) {
    stopCameraStream();
    previewVideo.srcObject = null;
    showPreview(Boolean(previewVideo.getAttribute("src")));
    cameraMessage.textContent = "已離開辨識頁，攝影機已自動關閉。";
  }
  if (id !== "generation" && genPlayer.getState() !== "idle") {
    genPlayer.stop();
    avatarStatus.textContent = "已停止";
  }

  closeMenu();

  const hash = "#" + id;
  if (location.hash !== hash) {
    if (push) history.pushState(null, "", hash);
    else history.replaceState(null, "", hash);
  }
  window.dispatchEvent(new CustomEvent("pagechange", { detail: id }));
  window.scrollTo(0, 0);
}

// 瀏覽器返回／前進鍵
window.addEventListener("hashchange", () => {
  const id = location.hash.slice(1);
  showPage(PAGES.includes(id) ? id : "home", false);
});

navLinks.forEach(a => {
  a.addEventListener("click", e => { e.preventDefault(); showPage(a.getAttribute("href").slice(1)); });
});

document.querySelector(".brand")?.addEventListener("click", e => {
  e.preventDefault(); showPage("home");
});

document.querySelectorAll(".ctas a").forEach(a => {
  a.addEventListener("click", e => { e.preventDefault(); showPage(a.getAttribute("href").slice(1)); });
});

// ── Keyboard Shortcuts ──
document.addEventListener("keydown", e => {
  if (e.target.matches("input, textarea, select")) return;
  // Enter／空白鍵在按鈕或連結上交給原生行為，避免雙重觸發
  if ((e.key === "Enter" || e.key === " ") && e.target.matches("button, a")) return;
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  const recPage = !document.querySelector("#recognition").hidden;
  const genPage = !document.querySelector("#generation").hidden;

  switch (e.key) {
    case "1": showPage("home");        break;
    case "2": showPage("recognition"); break;
    case "3": showPage("generation");  break;
    case "Enter":
      if (recPage) simulateRecognition();
      if (genPage) updateGeneration();
      break;
    case " ":
      if (genPage) {
        e.preventDefault();
        genPlayer.toggle();
      }
      break;
    case "Escape":
      if (genPlayer.getState() !== "idle") {
        genPlayer.stop();
        avatarStatus.textContent = "已停止";
        activeToken.textContent = "--";
      }
      break;
    case "?":
      if (kbdHelp) kbdHelp.open ? kbdHelp.close() : kbdHelp.showModal();
      break;
  }
});

// ── Quick Phrases ──
function renderQuickPhrases() {
  quickPhrases.innerHTML = "";
  QUICK_PHRASES.forEach(phrase => {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "chip-btn sample-text";
    btn.textContent = phrase;
    btn.addEventListener("click", () => { textInput.value = phrase; updateGeneration(); });
    quickPhrases.appendChild(btn);
  });
}

// ── Avatar Player ──
function createAvatarPlayer(figure, tokensEl, { onState, onToken } = {}) {
  const BASE_STEP_MS = 850;
  let timer = null;
  let tokens = [];
  let index = 0;
  let rate = 1;
  let state = "idle"; // idle | playing | paused | completed
  let singleToken = false;

  function emitState(next) {
    state = next;
    onState?.(state, { index, token: tokens[index], singleToken });
  }

  function setGesture(token) {
    let hash = 0;
    for (const char of token) hash = (hash + char.codePointAt(0)) % 4;
    figure.dataset.gesture = String(hash + 1);
    figure.style.setProperty("--gesture-duration", `${Math.round(1100 / rate)}ms`);
  }

  function updateHighlight(activeIndex = -1) {
    tokensEl.querySelectorAll("[data-token-index]").forEach((el, i) => {
      const active = i === activeIndex;
      el.classList.toggle("is-highlighted", active);
      el.setAttribute("aria-pressed", String(active));
    });
  }

  function stopAnimation() {
    clearTimeout(timer);
    timer = null;
    figure.classList.remove("is-signing");
  }

  function step() {
    if (!tokens.length) return;
    stopAnimation();
    setGesture(tokens[index]);
    // 重新加入 class，確保點擊同一詞卡時動畫仍會從頭播放。
    void figure.offsetWidth;
    figure.classList.add("is-signing");
    updateHighlight(index);
    onToken?.(tokens[index]);
    emitState("playing");
    timer = setTimeout(() => {
      stopAnimation();
      if (singleToken || index >= tokens.length - 1) {
        updateHighlight(-1);
        emitState("completed");
        return;
      }
      index += 1;
      step();
    }, BASE_STEP_MS / rate);
  }

  function load(nextTokens) {
    stopAnimation();
    tokens = [...nextTokens];
    index = 0;
    singleToken = false;
    updateHighlight(-1);
    emitState("idle");
  }

  function play(startIndex = null) {
    if (!tokens.length) return;
    if (Number.isInteger(startIndex)) index = Math.max(0, Math.min(startIndex, tokens.length - 1));
    else if (state === "completed" || state === "idle") index = 0;
    singleToken = false;
    step();
  }

  function playToken(tokenIndex) {
    if (!tokens[tokenIndex]) return;
    index = tokenIndex;
    singleToken = true;
    step();
  }

  function pause() {
    if (state !== "playing") return;
    stopAnimation();
    emitState("paused");
  }

  function resume() {
    if (!tokens.length) return;
    step();
  }

  function stop() {
    stopAnimation();
    singleToken = false;
    index = 0;
    updateHighlight(-1);
    emitState("idle");
  }

  function setRate(nextRate) {
    rate = nextRate;
    figure.style.setProperty("--gesture-duration", `${Math.round(1100 / rate)}ms`);
    if (state === "playing") step();
  }

  function toggle() {
    if (state === "playing") pause();
    else if (state === "paused") resume();
    else play();
  }

  return { load, play, playToken, pause, resume, stop, setRate, toggle, getState: () => state };
}

function syncPlaybackControls(state, detail = {}) {
  const hasTokens = currentGeneratedTokens.length > 0;
  const playing = state === "playing";
  startPlaybackButton.disabled = !hasTokens || playing;
  pausePlaybackButton.disabled = !playing;
  startPlaybackButton.querySelector("span").textContent = state === "paused" ? "繼續播放" : "開始播放";

  if (state === "playing") avatarStatus.textContent = "播放中";
  else if (state === "paused") avatarStatus.textContent = "已暫停";
  else if (state === "completed") {
    avatarStatus.textContent = detail.singleToken && detail.token ? `「${detail.token}」播放完成` : "播放完成";
  }
  else avatarStatus.textContent = "尚未播放";
  if (state !== "playing" && state !== "paused") activeToken.textContent = "--";
}

const genPlayer = createAvatarPlayer(avatarFigure, generationTokens, {
  onState: syncPlaybackControls,
  onToken: token => { activeToken.textContent = token; },
});

document.querySelectorAll(".speed-btn[data-rate]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".speed-btn[data-rate]").forEach(b => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    genPlayer.setRate(Number(btn.dataset.rate));
    generationStatus.textContent = `播放速率已調整為 ${btn.textContent}。`;
  });
});

// ── Helpers ──
function setPressed(button, pressed) {
  button.setAttribute("aria-pressed", String(pressed));
  button.classList.toggle("is-active", pressed);
}

function renderTokens(container, tokens, highlightedIndex = -1) {
  container.innerHTML = "";
  tokens.forEach((token, index) => {
    const span = document.createElement("span");
    span.className = "token";
    if (index === highlightedIndex) span.classList.add("is-highlighted");
    span.style.animationDelay = `${index * 55}ms`;
    span.textContent = token;
    container.appendChild(span);
  });
}

function renderGenerationTokens(tokens) {
  generationTokens.innerHTML = "";
  tokens.forEach((token, index) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "token token-button";
    button.dataset.tokenIndex = String(index);
    button.style.animationDelay = `${index * 55}ms`;
    button.textContent = token;
    button.setAttribute("aria-label", `單獨播放「${token}」的動作`);
    button.setAttribute("aria-pressed", "false");
    generationTokens.appendChild(button);
  });
}

function resetRecognitionSteps() {
  recognitionSteps.forEach(s => s.classList.remove("is-active", "is-complete"));
}

function stopCameraStream() {
  if (currentStream) { currentStream.getTracks().forEach(t => t.stop()); currentStream = null; }
}

function clearUploadedVideo() {
  if (uploadedVideoUrl) { URL.revokeObjectURL(uploadedVideoUrl); uploadedVideoUrl = null; }
}

function showPreview(hasPreview) {
  previewVideo.hidden = !hasPreview;
  emptyPreview.hidden = hasPreview;
}

// ── Camera ──
async function openCameraPreview() {
  if (!navigator.mediaDevices?.getUserMedia) {
    cameraMessage.textContent = "目前瀏覽器不支援攝影機，請改用影片上傳。";
    return;
  }
  try {
    stopCameraStream();
    clearUploadedVideo();
    previewVideo.removeAttribute("src");
    currentStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user" }, audio: false });
    previewVideo.srcObject = currentStream;
    previewVideo.play();
    showPreview(true);
    cameraMessage.textContent = "攝影機已開啟，請讓雙手完整出現在畫面中。";
    setPressed(videoModeButton, false);
    setPressed(cameraModeButton, true);
  } catch {
    cameraMessage.textContent = "無法開啟攝影機，請確認權限或改用影片上傳。";
  }
}

function useUploadMode() {
  stopCameraStream();
  previewVideo.srcObject = null;
  showPreview(Boolean(previewVideo.getAttribute("src")));
  setPressed(videoModeButton, true);
  setPressed(cameraModeButton, false);
  cameraMessage.textContent = "請上傳手語影片，系統會先保留手語語序。";
}

// ── Recognition ──
const recognitionKeys = Object.keys(recognitionSamples);
let recognitionRound  = 0;

function simulateRecognition() {
  const hasSource = Boolean(currentStream) || Boolean(previewVideo.getAttribute("src"));
  if (!hasSource) {
    setRecStatus("等待輸入", "idle");
    cameraMessage.textContent = "請先點擊上方新增手語影片，或切換到即時攝影機。";
    return;
  }
  const sample = recognitionSamples[recognitionKeys[recognitionRound++ % recognitionKeys.length]];
  clearTimeout(recognitionTimer);
  resetRecognitionSteps();
  renderTokens(recognitionTokens, []);
  spokenResult.textContent = "辨識中，請稍候…";
  setRecStatus("分析中", "active");
  recognitionSteps[0].classList.add("is-active");

  recognitionTimer = setTimeout(() => {
    recognitionSteps[0].classList.replace("is-active", "is-complete");
    recognitionSteps[1].classList.add("is-active");
    setRecStatus("語序辨識", "active");
    renderTokens(recognitionTokens, sample.signOrder);

    recognitionTimer = setTimeout(() => {
      recognitionSteps[1].classList.replace("is-active", "is-complete");
      recognitionSteps[2].classList.add("is-active");
      setRecStatus("口語轉換", "active");

      recognitionTimer = setTimeout(() => {
        recognitionSteps[2].classList.replace("is-active", "is-complete");
        spokenResult.textContent = sample.spokenText;
        setRecStatus("辨識完成", "done");
        cameraMessage.textContent = "已保留原始手語語序，並整理成口語句子。";
      }, 700);
    }, 800);
  }, 700);
}

// ── Generation ──
function fallbackGeneration(sentence) {
  const cleaned = sentence.replace(/[，。！？\s]/g, "");
  if (!cleaned) return [];
  if (cleaned.includes("我要")) return ["我", cleaned.replace("我要", ""), "要"].filter(Boolean);
  return cleaned.split("").slice(0, 6);
}

function convertToSignOrder(sentence) {
  return generationSamples[sentence.trim()] || fallbackGeneration(sentence.trim());
}

// ── 語言模型 API（Gemma 4 QLoRA，中文 → TSL Gloss）──
// 預設連本機 8018；模型跑在學校 VM，需先開 SSH 通道：
//   ssh -p 2288 -N -L 8018:localhost:8018 b310ai@<VM 位址>
// 未連線時自動退回內建對照表，前端仍可展示。
const GLOSS_API = (localStorage.getItem("glossApi") || "http://127.0.0.1:8018").replace(/\/$/, "");
let glossApiOnline = null;   // null=未測、true/false=已測

async function translateViaModel(sentence, timeoutMs = 60000) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GLOSS_API}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sentence }),
      signal: ctrl.signal,
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data.gloss) || !data.gloss.length) throw new Error("空結果");
    glossApiOnline = true;
    return { tokens: data.gloss, seconds: data.seconds };
  } finally {
    clearTimeout(timer);
  }
}

async function updateGeneration() {
  const sentence = textInput.value.trim();
  if (!sentence) {
    generationStatus.textContent = "請先輸入一句口語，例如：你好";
    originalSentence.textContent = "尚未輸入內容";
    currentGeneratedTokens = [];
    renderGenerationTokens([]);
    genPlayer.load([]);
    return;
  }

  originalSentence.textContent = sentence;
  generationStatus.textContent = "語言模型翻譯中…";

  let tokens, note;
  try {
    const r = await translateViaModel(sentence);
    tokens = r.tokens;
    note = `語言模型（Gemma 4 微調）翻譯完成，耗時 ${r.seconds}s。`;
  } catch (err) {
    glossApiOnline = false;
    tokens = convertToSignOrder(sentence);
    note = `未連上語言模型（${err.message}），改用內建對照表。`;
  }

  currentGeneratedTokens = tokens;
  renderGenerationTokens(currentGeneratedTokens);
  genPlayer.load(currentGeneratedTokens);
  generationStatus.textContent = `${note}`;
  playAvatarSequence();
}

function playAvatarSequence() {
  if (!currentGeneratedTokens.length) {
    generationStatus.textContent = "請先完成手語語序轉換，再播放虛擬人。";
    return;
  }
  genPlayer.play();
}

// ── Event Listeners ──
function loadVideoFile(file) {
  stopCameraStream();
  clearUploadedVideo();
  previewVideo.srcObject = null;
  uploadedVideoUrl = URL.createObjectURL(file);
  previewVideo.src = uploadedVideoUrl;
  showPreview(true);
  cameraMessage.textContent = `已載入影片：${file.name}，可以開始辨識。`;
  setPressed(videoModeButton, true);
  setPressed(cameraModeButton, false);
}

videoUpload.addEventListener("change", e => {
  const [file] = e.currentTarget.files;
  if (file) loadVideoFile(file);
  e.currentTarget.value = "";
});

emptyPreview.addEventListener("click", () => videoUpload.click());

// 拖曳影片到預覽區
previewBox.addEventListener("dragover", e => { e.preventDefault(); previewBox.classList.add("is-dragover"); });
previewBox.addEventListener("dragleave", () => previewBox.classList.remove("is-dragover"));
previewBox.addEventListener("drop", e => {
  e.preventDefault();
  previewBox.classList.remove("is-dragover");
  const file = e.dataTransfer.files?.[0];
  if (file?.type.startsWith("video/")) loadVideoFile(file);
  else cameraMessage.textContent = "只支援影片檔案，請重新拖曳。";
});

videoModeButton.addEventListener("click", () => {
  useUploadMode();
  // 尚未載入影片時直接開檔案選取器，省一步
  if (!previewVideo.getAttribute("src")) videoUpload.click();
});
cameraModeButton.addEventListener("click", openCameraPreview);
document.querySelector("#startRecognition").addEventListener("click", simulateRecognition);

document.querySelector("#resetRecognition").addEventListener("click", () => {
  clearTimeout(recognitionTimer);
  resetRecognitionSteps();
  renderTokens(recognitionTokens, []);
  spokenResult.textContent = "尚未辨識";
  setRecStatus("等待輸入", "idle");
  // 一併清掉影像來源，回到初始狀態
  stopCameraStream();
  clearUploadedVideo();
  previewVideo.srcObject = null;
  previewVideo.removeAttribute("src");
  showPreview(false);
  setPressed(videoModeButton, true);
  setPressed(cameraModeButton, false);
  cameraMessage.textContent = "系統先顯示手語語序，再整理成口語。";
});

document.querySelector("#generateSign").addEventListener("click", updateGeneration);
startPlaybackButton.addEventListener("click", () => {
  if (genPlayer.getState() === "paused") genPlayer.resume();
  else playAvatarSequence();
});
pausePlaybackButton.addEventListener("click", () => genPlayer.pause());

generationTokens.addEventListener("click", e => {
  const button = e.target.closest("button[data-token-index]");
  if (!button) return;
  const index = Number(button.dataset.tokenIndex);
  genPlayer.playToken(index);
  generationStatus.textContent = `正在單獨播放「${currentGeneratedTokens[index]}」的動作。`;
});

document.querySelector("#clearText").addEventListener("click", () => {
  genPlayer.stop();
  textInput.value = "";
  originalSentence.textContent = "尚未輸入內容";
  currentGeneratedTokens = [];
  renderGenerationTokens([]);
  genPlayer.load([]);
  generationStatus.textContent = "內容已清除，請重新輸入一句口語。";
});

// Enter 直接轉換（Shift+Enter 換行）
textInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    updateGeneration();
  }
});

window.addEventListener("beforeunload", () => {
  stopCameraStream();
  genPlayer.stop();
  clearUploadedVideo();
});

// ── Keyboard Help Dialog ──
const kbdHelp = document.querySelector("#kbdHelp");
document.querySelector("#kbdHelpBtn")?.addEventListener("click", () => kbdHelp?.showModal());
document.querySelector("#kbdClose")?.addEventListener("click", () => kbdHelp?.close());
kbdHelp?.addEventListener("click", e => { if (e.target === kbdHelp) kbdHelp.close(); });

// ── Init ──
const initialPage = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
showPage(initialPage, false);
renderQuickPhrases();
renderGenerationTokens(currentGeneratedTokens);
genPlayer.load(currentGeneratedTokens);
showPreview(false);
