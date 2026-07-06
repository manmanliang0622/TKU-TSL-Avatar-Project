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
  drink:    { signOrder: ["我", "水", "喝", "要"], spokenText: "我要喝水",   confidence: "94%", history: "手語語序：我 / 水 / 喝 / 要 → 口語：我要喝水" },
  register: { signOrder: ["我", "掛號", "要"],     spokenText: "我要掛號",   confidence: "96%", history: "手語語序：我 / 掛號 / 要 → 口語：我要掛號" },
  help:     { signOrder: ["請", "我", "幫忙"],     spokenText: "請幫我一下", confidence: "91%", history: "手語語序：請 / 我 / 幫忙 → 口語：請幫我一下" },
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

// ── localStorage Keys ──
const STORAGE_GEN = "tsl_gen_history";
const STORAGE_REC = "tsl_rec_history";
const STORAGE_FAV = "tsl_favorites";
const MAX_HIST = 10;
const MAX_FAV  = 20;

// ── DOM refs ──
const previewVideo        = document.querySelector("#previewVideo");
const previewBox          = document.querySelector("#previewBox");
const emptyPreview        = document.querySelector("#emptyPreview");
const videoUpload         = document.querySelector("#videoUpload");
const recognitionTokens   = document.querySelector("#recognitionTokens");
const spokenResult        = document.querySelector("#spokenResult");
const recognitionStatus   = document.querySelector("#recognitionStatus");
const cameraMessage       = document.querySelector("#cameraMessage");
const recognitionHistory  = document.querySelector("#recognitionHistory");
const generationHistory   = document.querySelector("#generationHistory");

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
const favBtn               = document.querySelector("#favBtn");
const favoritesList        = document.querySelector("#favoritesList");
const favSearchRow         = document.querySelector("#favSearchRow");
const favSearch            = document.querySelector("#favSearch");
const favUndoBar           = document.querySelector("#favUndoBar");
const favUndoText          = document.querySelector("#favUndoText");
const favAvatarFigure      = document.querySelector("#favAvatarFigure");
const favAvatarStatus      = document.querySelector("#favAvatarStatus");
const favSelectedSentence  = document.querySelector("#favSelectedSentence");
const favTokensEl          = document.querySelector("#favTokens");

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
const PAGES        = ["home", "recognition", "generation", "favorites", "history"];
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
  if (id !== "generation" && genPlayer.isPlaying()) {
    genPlayer.stop();
    avatarStatus.textContent = "已暫停";
  }
  if (id !== "favorites" && favPlayer.isPlaying()) {
    favPlayer.stop();
    setFavStatus("已暫停", "idle");
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
  if (PAGES.includes(id)) showPage(id, false);
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
    case "4": showPage("favorites");   break;
    case "5": showPage("history");     break;
    case "Enter":
      if (recPage) simulateRecognition();
      if (genPage) updateGeneration();
      break;
    case " ":
      if (genPage) {
        e.preventDefault();
        if (genPlayer.isPlaying()) {
          genPlayer.stop();
          avatarStatus.textContent = "已暫停";
        } else {
          playAvatarSequence();
        }
      }
      break;
    case "Escape":
      if (genPlayer.isPlaying()) {
        genPlayer.stop();
        avatarStatus.textContent = "已暫停";
        activeToken.textContent = "--";
      }
      if (favPlayer.isPlaying()) {
        favPlayer.stop();
        setFavStatus("已暫停", "idle");
      }
      break;
    case "?":
      if (kbdHelp) kbdHelp.open ? kbdHelp.close() : kbdHelp.showModal();
      break;
  }
});

// ── localStorage: History ──
function saveHistory(key, text) {
  let arr = [];
  try { arr = JSON.parse(localStorage.getItem(key) || "[]"); } catch (_) {}
  arr = arr.filter(t => t !== text);
  arr.unshift(text);
  arr = arr.slice(0, MAX_HIST);
  try { localStorage.setItem(key, JSON.stringify(arr)); } catch (_) {}
  return arr;
}

function sentenceFromHistory(text) {
  const m = text.match(/(?:原句|口語)：([^→]+)/);
  return m ? m[1].trim() : null;
}

function renderHistory(listEl, arr, emptyText) {
  listEl.innerHTML = "";
  if (!arr.length) { addLi(listEl, emptyText, "empty-item"); return; }
  arr.forEach(t => {
    const sentence = sentenceFromHistory(t);
    if (!sentence) { addLi(listEl, t); return; }
    const li = document.createElement("li");
    li.className = "history-item";
    const btn = document.createElement("button");
    btn.type = "button";
    btn.dataset.sentence = sentence;
    btn.textContent = t;
    btn.title = "點一下在生成頁重播";
    btn.setAttribute("aria-label", `在生成頁重播：${sentence}`);
    li.appendChild(btn);
    listEl.appendChild(li);
  });
}

function loadHistory() {
  try {
    const genArr = JSON.parse(localStorage.getItem(STORAGE_GEN) || "[]");
    const recArr = JSON.parse(localStorage.getItem(STORAGE_REC) || "[]");
    if (genArr.length) renderHistory(generationHistory, genArr, "尚無生成紀錄");
    if (recArr.length) renderHistory(recognitionHistory, recArr, "尚無辨識紀錄");
  } catch (_) {}
}

// ── localStorage: Favorites ──
function getFavorites() {
  try { return JSON.parse(localStorage.getItem(STORAGE_FAV) || "[]"); } catch (_) { return []; }
}

function saveFavorites(arr) {
  try { localStorage.setItem(STORAGE_FAV, JSON.stringify(arr)); } catch (_) {}
}

function renderFavorites() {
  const arr = getFavorites();
  favoritesList.innerHTML = "";
  favSearchRow.hidden = arr.length < 5;
  if (!arr.length) {
    const li = document.createElement("li");
    li.className = "empty-item";
    li.innerHTML = `尚無收藏，先把常用句子加入收藏。<button type="button" class="link-btn" data-goto="generation">前往手語生成 →</button>`;
    favoritesList.appendChild(li);
    return;
  }
  const query = favSearchRow.hidden ? "" : favSearch.value.trim();
  const shown = query ? arr.filter(t => t.includes(query)) : arr;
  if (!shown.length) {
    addLi(favoritesList, `沒有符合「${query}」的收藏`, "empty-item");
    return;
  }
  shown.forEach(text => {
    const li = document.createElement("li");
    li.innerHTML = `
      <button class="fav-play" data-text="${escHtml(text)}" aria-label="播放 ${escHtml(text)} 的手語">
        <svg width="9" height="10" viewBox="0 0 10 12" fill="currentColor" aria-hidden="true"><polygon points="0,0 10,6 0,12"/></svg>
      </button>
      <span class="fav-sentence" data-text="${escHtml(text)}">${escHtml(text)}</span>
      <button class="fav-del" data-text="${escHtml(text)}" aria-label="移除收藏">×</button>`;
    favoritesList.appendChild(li);
  });
}

function updateFavBtnState() {
  const sentence = textInput.value.trim();
  const isFav = getFavorites().includes(sentence);
  favBtn.textContent = isFav ? "★ 已收藏" : "☆ 收藏";
  favBtn.classList.toggle("is-favorited", isFav);
}

favBtn?.addEventListener("click", () => {
  const sentence = textInput.value.trim();
  if (!sentence) return;
  let arr = getFavorites();
  if (arr.includes(sentence)) {
    arr = arr.filter(t => t !== sentence);
  } else {
    arr.unshift(sentence);
    arr = arr.slice(0, MAX_FAV);
  }
  saveFavorites(arr);
  updateFavBtnState();
  renderFavorites();
});

// ── Favorites: 移除後可復原 ──
let favUndoData  = null;
let favUndoTimer = null;

function hideFavUndo() {
  favUndoBar.hidden = true;
  favUndoData = null;
}

function showFavUndo(text, index) {
  favUndoData = { text, index };
  favUndoText.textContent = `已移除「${text}」`;
  favUndoBar.hidden = false;
  clearTimeout(favUndoTimer);
  favUndoTimer = setTimeout(hideFavUndo, 6000);
}

document.querySelector("#favUndoBtn")?.addEventListener("click", () => {
  if (!favUndoData) return;
  const arr = getFavorites();
  arr.splice(Math.min(favUndoData.index, arr.length), 0, favUndoData.text);
  saveFavorites(arr);
  renderFavorites();
  updateFavBtnState();
  hideFavUndo();
});

favSearch?.addEventListener("input", () => renderFavorites());

favoritesList?.addEventListener("click", e => {
  // 移除收藏
  const delBtn = e.target.closest(".fav-del");
  if (delBtn) {
    const text = delBtn.dataset.text;
    const arr = getFavorites();
    const index = arr.indexOf(text);
    saveFavorites(arr.filter(t => t !== text));
    renderFavorites();
    updateFavBtnState();
    showFavUndo(text, index);
    return;
  }

  // 播放手語：點播放鈕或句子文字 → 在收藏頁右側播放
  const playTrigger = e.target.closest(".fav-play") || e.target.closest(".fav-sentence");
  if (playTrigger) {
    const text = playTrigger.dataset.text;
    if (!text) return;
    const tokens = convertToSignOrder(text);
    favSelectedSentence.textContent = text;
    renderTokens(favTokensEl, tokens);
    setFavStatus("準備中", "idle");
    favPlayer.play(tokens);
  }
});

function escHtml(str) {
  return str.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

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

// ── Favorites Avatar ──
function setFavStatus(text, state = "idle") {
  if (!favAvatarStatus) return;
  favAvatarStatus.textContent = text;
  favAvatarStatus.dataset.state = state;
}

// ── Avatar Player（生成頁與收藏頁共用） ──
function createAvatarPlayer(figure, tokensEl, { onStart, onToken, onDone } = {}) {
  let timer = null;
  let interval = 850;
  const isPlaying = () => Boolean(figure?.classList.contains("is-signing"));

  function stop() {
    clearTimeout(timer);
    figure?.classList.remove("is-signing");
  }

  function play(tokens) {
    if (!tokens.length) return;
    stop();
    figure.classList.add("is-signing");
    onStart?.();
    let index = 0;
    const step = () => {
      renderTokens(tokensEl, tokens, index);
      onToken?.(tokens[index]);
      // 每步重新讀取 interval，速度切換立即生效
      timer = setTimeout(() => {
        index += 1;
        if (index >= tokens.length) {
          stop();
          renderTokens(tokensEl, tokens);
          onDone?.();
          return;
        }
        step();
      }, interval);
    };
    step();
  }

  return { play, stop, isPlaying, setSpeed(ms) { interval = ms; } };
}

const genPlayer = createAvatarPlayer(avatarFigure, generationTokens, {
  onStart: () => { avatarStatus.textContent = "播放中"; },
  onToken: token => { activeToken.textContent = token; },
  onDone:  () => { avatarStatus.textContent = "播放完成"; activeToken.textContent = "--"; },
});

const favPlayer = createAvatarPlayer(favAvatarFigure, favTokensEl, {
  onStart: () => setFavStatus("播放中", "active"),
  onDone:  () => setFavStatus("播放完成", "done"),
});

// ── Playback Speed ──
function bindSpeedButtons(selector, player) {
  const buttons = document.querySelectorAll(selector);
  buttons.forEach(btn => {
    btn.addEventListener("click", () => {
      buttons.forEach(b => { b.classList.remove("is-active"); b.setAttribute("aria-pressed", "false"); });
      btn.classList.add("is-active");
      btn.setAttribute("aria-pressed", "true");
      player.setSpeed(parseInt(btn.dataset.speed, 10));
    });
  });
}
bindSpeedButtons(".fav-speed-btn", favPlayer);
bindSpeedButtons(".speed-btn:not(.fav-speed-btn)", genPlayer);

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

function addLi(list, text, cls = "") {
  const li = document.createElement("li");
  if (cls) li.className = cls;
  li.textContent = text;
  list.appendChild(li);
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
        renderHistory(recognitionHistory, saveHistory(STORAGE_REC, sample.history), "尚無辨識紀錄");
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

function updateGeneration() {
  const sentence = textInput.value.trim();
  if (!sentence) {
    generationStatus.textContent = "請先輸入一句口語，例如：你好";
    originalSentence.textContent = "尚未輸入內容";
    renderTokens(generationTokens, []);
    currentGeneratedTokens = [];
    updateFavBtnState();
    return;
  }
  currentGeneratedTokens = convertToSignOrder(sentence);
  originalSentence.textContent = sentence;
  renderTokens(generationTokens, currentGeneratedTokens);
  generationStatus.textContent = "已轉成台灣手語語序，自動播放中。";
  const histText = `原句：${sentence} → 手語語序：${currentGeneratedTokens.join(" / ")}`;
  renderHistory(generationHistory, saveHistory(STORAGE_GEN, histText), "尚無生成紀錄");
  updateFavBtnState();
  playAvatarSequence();
}

function playAvatarSequence() {
  if (!currentGeneratedTokens.length) {
    generationStatus.textContent = "請先完成手語語序轉換，再播放虛擬人。";
    return;
  }
  genPlayer.play(currentGeneratedTokens);
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
document.querySelector("#playAvatar").addEventListener("click", playAvatarSequence);

document.querySelector("#clearText").addEventListener("click", () => {
  genPlayer.stop();
  textInput.value = "";
  originalSentence.textContent = "尚未輸入內容";
  renderTokens(generationTokens, []);
  generationStatus.textContent = "內容已清除，請重新輸入一句口語。";
  avatarStatus.textContent = "尚未播放";
  activeToken.textContent = "--";
  currentGeneratedTokens = [];
  updateFavBtnState();
});

textInput.addEventListener("input", updateFavBtnState);

// Enter 直接轉換（Shift+Enter 換行）
textInput.addEventListener("keydown", e => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    updateGeneration();
  }
});

// ── Clear History（按第一下變確認，3 秒內再按才清除） ──
function armClearButton(btn, onConfirm) {
  let armedTimer = null;
  btn.addEventListener("click", () => {
    if (armedTimer) {
      clearTimeout(armedTimer);
      armedTimer = null;
      btn.textContent = "清除";
      btn.classList.remove("is-armed");
      onConfirm();
      return;
    }
    btn.textContent = "確定清除？";
    btn.classList.add("is-armed");
    armedTimer = setTimeout(() => {
      armedTimer = null;
      btn.textContent = "清除";
      btn.classList.remove("is-armed");
    }, 3000);
  });
}

armClearButton(document.querySelector("#clearRecHistory"), () => {
  localStorage.removeItem(STORAGE_REC);
  renderHistory(recognitionHistory, [], "尚無辨識紀錄");
});
armClearButton(document.querySelector("#clearGenHistory"), () => {
  localStorage.removeItem(STORAGE_GEN);
  renderHistory(generationHistory, [], "尚無生成紀錄");
});

// ── 空狀態引導：data-goto 跳頁 ──
document.addEventListener("click", e => {
  const goto = e.target.closest("[data-goto]");
  if (goto) showPage(goto.dataset.goto);
});

window.addEventListener("beforeunload", () => {
  stopCameraStream();
  genPlayer.stop();
  favPlayer.stop();
  clearUploadedVideo();
});

// ── Keyboard Help Dialog ──
const kbdHelp = document.querySelector("#kbdHelp");
document.querySelector("#kbdHelpBtn")?.addEventListener("click", () => kbdHelp?.showModal());
document.querySelector("#kbdClose")?.addEventListener("click", () => kbdHelp?.close());
kbdHelp?.addEventListener("click", e => { if (e.target === kbdHelp) kbdHelp.close(); });

// ── History Replay ──
[recognitionHistory, generationHistory].forEach(list => {
  list.addEventListener("click", e => {
    const btn = e.target.closest("button[data-sentence]");
    if (!btn) return;
    showPage("generation");
    textInput.value = btn.dataset.sentence;
    updateGeneration();
  });
});

// ── Init ──
const initialPage = PAGES.includes(location.hash.slice(1)) ? location.hash.slice(1) : "home";
showPage(initialPage, false);
loadHistory();
renderFavorites();
renderQuickPhrases();
renderTokens(generationTokens, currentGeneratedTokens);
showPreview(false);
updateFavBtnState();
