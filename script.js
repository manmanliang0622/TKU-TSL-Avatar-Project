// ════════════════════════════════════════════
//  譯手通 SignTranslate — Hero reveal + 雙向手語功能
// ════════════════════════════════════════════

// ── Hero Reveal Lens ──
(function () {
  // 透鏡以 .hero-frame 為座標基準
  const homeSection = document.getElementById('home');
  const hero   = document.querySelector('#home .hero-frame');
  const reveal = document.getElementById('reveal');
  if (!homeSection || !hero || !reveal) return;
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

  // ── 左側「譯手通」直欄：游標愈近，該行字愈大（純 transform，不觸發重排） ──
  const brandCol  = document.querySelector('#home .brand-column');
  const brandRows = brandCol ? Array.from(brandCol.children) : [];
  const BRAND_AMP     = 0.42;  // 正對游標那行的最大放大幅度
  const BRAND_FAR     = 0.28;  // 游標遠離直欄時仍保留的感應強度
  const BRAND_SIGMA_X = 460;   // 水平感應半徑（px）
  const BRAND_SIGMA_Y = 1.9;   // 垂直感應半徑（幾倍行高）
  let rowGeom = [], colLeft = 0, colRight = 0;
  const lastCss = [];   // 值沒變就不寫回，靜止時不必每幀觸發樣式重算

  // 量測前先清掉 transform，取得未縮放的版面座標（與 x／y 同樣以 hero 左上角為原點）
  function measureRows() {
    if (!brandRows.length) return;
    for (let i = 0; i < brandRows.length; i++) { brandRows[i].style.transform = ''; lastCss[i] = ''; }
    const base = hero.getBoundingClientRect();
    rowGeom = brandRows.map(el => {
      const b = el.getBoundingClientRect();
      return { top: b.top - base.top, h: b.height || 1 };
    });
    const c = brandCol.getBoundingClientRect();
    colLeft  = c.left  - base.left;
    colRight = c.right - base.left;
  }
  measureRows();
  if (document.fonts && document.fonts.ready) document.fonts.ready.then(measureRows);

  function paintRows() {
    if (reduced || !rowGeom.length) return;
    const strength = Math.min(1, Math.max(0, r / RADIUS));   // 透鏡收起時同步收斂回原尺寸
    const dxOut = Math.max(colLeft - x, x - colRight, 0);
    const near  = BRAND_FAR + (1 - BRAND_FAR) * Math.exp(-Math.pow(dxOut / BRAND_SIGMA_X, 2));

    const scales = [];
    let extraTotal = 0;
    for (let i = 0; i < rowGeom.length; i++) {
      const g  = rowGeom[i];
      const dy = y - (g.top + g.h / 2);
      const w  = Math.exp(-Math.pow(dy / (g.h * BRAND_SIGMA_Y), 2));
      const s  = 1 + BRAND_AMP * strength * near * w;
      scales.push(s);
      extraTotal += (s - 1) * g.h;
    }
    // 把撐開的高度平均分到上下兩側，直欄的視覺重心維持不動
    let shift = -extraTotal / 2;
    for (let i = 0; i < rowGeom.length; i++) {
      const css = 'translateY(' + shift.toFixed(2) + 'px) scale(' + scales[i].toFixed(4) + ')';
      if (css !== lastCss[i]) { brandRows[i].style.transform = css; lastCss[i] = css; }
      shift += (scales[i] - 1) * rowGeom[i].h;
    }
  }

  window.addEventListener('resize', () => {
    updateRect();
    measureRows();
    if (!hasMoved) setInitial();
  });

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

  // ── 進站自動掃過一次 ──
  // 使用者不會知道游標可以揭開插圖，所以先演一次給他看：0.8 秒從插圖左緣
  // 橫掃到右緣，半徑先張開、末段收回，掃完回到平常那層淡淡的樣子。
  // 期間直接寫 x/y/r 繞過下面 frame() 的緩動 —— k=0.09 會把 0.8 秒拖成兩三秒。
  // 使用者中途自己動滑鼠就立刻讓位，不跟他搶。
  const INTRO_MS = 800;
  let introStart = null;
  if (!reduced) setTimeout(() => { if (!hasMoved) introStart = performance.now(); }, 260);

  function runIntro(now) {
    const t = Math.min(1, (now - introStart) / INTRO_MS);
    const ease = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
    x = tx = heroRect.width * (0.42 + 0.48 * ease);   // 插圖左緣掃到右緣
    y = ty = heroRect.height * 0.55;
    const env = t < 0.18 ? t / 0.18 : (t > 0.72 ? (1 - t) / 0.28 : 1);
    r = tr = RADIUS * Math.max(0, env);
    if (t >= 1) introStart = null;
  }

  // gentle automatic drift before first interaction (so touch users see the magic)
  // 2400ms：讓進站橫掃（260 + 800）跑完、留一拍靜止，再接上漫遊
  setTimeout(() => { if (!hasMoved && !reduced) idleActive = true; }, 2400);

  let rafId = null;
  function frame() {
    if (introStart !== null) {
      if (hasMoved) {
        introStart = null;               // 使用者自己動了，把控制權還給他
      } else {
        runIntro(performance.now());
        reveal.style.setProperty('--mx', x.toFixed(1) + 'px');
        reveal.style.setProperty('--my', y.toFixed(1) + 'px');
        reveal.style.setProperty('--r', Math.max(0, r).toFixed(1) + 'px');
        paintRows();
        rafId = requestAnimationFrame(frame);
        return;
      }
    }
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
    paintRows();
    rafId = requestAnimationFrame(frame);
  }

  // 只在首頁可見且分頁在前景時跑動畫迴圈
  function startLoop() { if (rafId === null) rafId = requestAnimationFrame(frame); }
  function stopLoop()  { if (rafId !== null) { cancelAnimationFrame(rafId); rafId = null; } }
  function syncLoop()  { (document.hidden || homeSection.hidden) ? stopLoop() : startLoop(); }

  document.addEventListener('visibilitychange', syncLoop);
  window.addEventListener('pagechange', () => {
    syncLoop();
    if (!homeSection.hidden) { updateRect(); measureRows(); }
  });
  startLoop();
})();

// ── Vocabulary Data ──
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

let currentStream    = null;
// 0813 排版：輸入框空白起始，不預載示範句
let currentGeneratedTokens = [];
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
  }
  if (id !== "generation" && genPlayer.getState() !== "idle") {
    genPlayer.stop();
    avatarStatus.textContent = "已停止";
  }

  closeMenu();

  const hash = "#" + id;
  if (location.hash !== hash) {
    if (push) history.pushState(null, "", hash);
    // 裸網址（無 hash）進站時不補寫 #generation，分享的短網址保持乾淨
    else if (location.hash) history.replaceState(null, "", hash);
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
      if (recPage) startRecognition();
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
    /* 3D 橋接接得上時由它畫詞卡：這裡是固定 850ms 一個詞，它是照實際片段
       長度走的，兩邊各亮各的就會跟下方時間軸對不上。接不上（後端沒開、
       詞庫沒有這些詞）時 dataset 不會被設，仍由這裡負責。 */
    if (tokensEl.dataset.playback === "3d") return;
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

  /* 3D 交還主導權時用：把詞卡與控制列重畫成這個播放器當下的狀態。
     交還的瞬間如果沒人重畫，畫面會停在 3D 最後留下的樣子。 */
  function resync() {
    updateHighlight(state === "playing" ? index : -1);
    emitState(state);
  }

  return { load, play, playToken, pause, resume, stop, setRate, toggle, resync, getState: () => state };
}

function syncPlaybackControls(state, detail = {}) {
  const hasTokens = currentGeneratedTokens.length > 0;
  const playing = state === "playing";
  // 只看有沒有句子可以打：原本播放中就鎖住，點完詞卡的頭 850ms 內
  // 「整句播放」是死的——那正是使用者最想按它的時候。
  startPlaybackButton.disabled = !hasTokens;
  /* 3D 接上時，暫停鈕、鈕上的字、狀態文字與目前詞都由 signavatar-bridge
     照實際片段進度寫。這裡是固定 850ms 的佔位時鐘，會在 3D 還在播的時候
     就把暫停鈕變灰、把狀態寫成「播放完成」。 */
  if (generationTokens.dataset.playback === "3d") return;
  pausePlaybackButton.disabled = !playing;
  // 「整句播放」而不是「開始播放」：詞卡可單獨試播，這顆鈕永遠是回到整句
  startPlaybackButton.querySelector("span").textContent = state === "paused" ? "繼續播放" : "整句播放";

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
  // 目前詞不經過 syncPlaybackControls，得各自擋一次：3D 主導時由橋接寫
  onToken: token => {
    if (generationTokens.dataset.playback !== "3d") activeToken.textContent = token;
  },
});

// 3D 播不出來（後端掛了、詞庫缺片段）時橋接會把主導權還回來，這裡接手重畫
window.addEventListener("signavatar:playback-released", () => genPlayer.resync());

document.querySelectorAll(".speed-btn[data-rate]").forEach(btn => {
  btn.addEventListener("click", () => {
    document.querySelectorAll(".speed-btn[data-rate]").forEach(b => {
      const active = b === btn;
      b.classList.toggle("is-active", active);
      b.setAttribute("aria-pressed", String(active));
    });
    genPlayer.setRate(Number(btn.dataset.rate));
    setGenerationStatus(`播放速率已調整為 ${btn.textContent}。`);
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

// 攝影機模式的畫面差異：自拍要鏡像（CSS 同時翻轉 video 與骨架 canvas），
// 即時串流沒有時間軸可拖，原生播放列只會擋住畫面。
function setCameraView(on) {
  previewBox.classList.toggle("is-camera", on);
  previewVideo.controls = !on;
}

function stopCameraStream() {
  setCameraView(false);
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
  // 辨識頁不放提示或錯誤說明；打不開攝影機時「即時攝影機」按鈕不會亮起
  if (!navigator.mediaDevices?.getUserMedia) {
    console.warn("[camera] 這個瀏覽器不支援 getUserMedia");
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
    setCameraView(true);
    setPressed(videoModeButton, false);
    setPressed(cameraModeButton, true);
  } catch (err) {
    console.warn("[camera] 無法開啟攝影機", err);
  }
}

function useUploadMode() {
  stopCameraStream();
  previewVideo.srcObject = null;
  showPreview(Boolean(previewVideo.getAttribute("src")));
  setPressed(videoModeButton, true);
  setPressed(cameraModeButton, false);
}

// ── Recognition ──
/* 辨識一律交給 knee42-client.js（window.Knee42）。它沒掛上來 —— 模組檔沒載到、
 * 執行途中出錯 —— 就明講辨識用不了。以前這裡會輪播三句內建樣本，照樣走完
 * 三個步驟、顯示「辨識完成」：那句話跟使用者比了什麼毫無關係，畫面上卻和
 * 真的辨識結果一模一樣（與翻譯不再偽造結果是同一條規矩）。 */
function startRecognition() {
  if (window.Knee42) {
    window.Knee42.toggle();
    return;
  }
  resetRecognitionSteps();
  renderTokens(recognitionTokens, []);
  spokenResult.textContent = "尚未辨識";
  setRecStatus("無法辨識", "idle");
}

// ── Generation ──
/* 語言模型連不上時的離線退路：只認上面那張人工核對過的對照表，查不到就回空。
 *
 * 舊版查不到會退到 fallbackGeneration —— 把句子逐字拆開取前六個字當答案。
 * 問題是詞庫有一萬七千條、幾乎每個單字都查得到，所以那串單字真的排得出詞卡、
 * 虛擬人也真的會動：畫面上跟一次成功的翻譯長得一模一樣，只有語序整個是假的。
 * 0913 組員測到的「同一句翻兩次不一樣」就是一次走模型、一次走這條；0914 早上
 * 教授那次則是後端整台不通，連動作片段也抓不到，於是連虛擬人都不動。
 * 寧可明講這句翻不出來，也不要給一個看起來正常的錯答案。*/
function convertToSignOrder(sentence) {
  return generationSamples[sentence.trim()] || [];
}

// ── 語言模型 API（Gemma 4 QLoRA，中文 → TSL Gloss）──
// 預設同源：學校主機 bundle_server 直接提供 /translate；
// 本機開發伺服器（8742）以代理轉發到 SSH 通道（127.0.0.1:8018 → 學校 8084）。
// 連不上時自動退回內建對照表，前端仍可展示。可用 localStorage.glossApi 覆寫。
// pages.dev 等靜態部署：apiBase 是同源的 /api，由 functions/api/[[path]].js
// 轉給學校那台（tunnel 網址存在 KV，前端不必知道）。
const GLOSS_API = (localStorage.getItem("glossApi")
  || window.SignAvatarConfig?.apiBase
  || location.origin).replace(/\/$/, "");
let glossApiOnline = null;   // null=未測、true/false=已測

// 這幾種狀態碼都是「再等一下就會好」，不是真的離線：
//   503 bundle_server 連不上模型子程序 —— 模型載入要幾十秒，這段時間每一次都是 503
//   502 Pages Function 打不到學校那台 —— cloudflared 換通道時 KV 最多有 30 秒還是舊網址
//   504 上游逾時
// 它們都是「立刻」回來的，所以重試不會拖長時間（實測暖機後一句 6-9 秒，
// 這三次加起來的等待上限約 11 秒）。逾時則不重試：那代表模型真的在跑，
// 再送一次只會排在 INFERENCE_LOCK 後面，等更久。
const TRANSLATE_RETRY_STATUS = new Set([502, 503, 504]);
const TRANSLATE_RETRY_DELAYS = [3000, 8000];

async function translateOnce(sentence, timeoutMs) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${GLOSS_API}/translate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: sentence }),
      signal: ctrl.signal,
    });
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status}`);
      err.status = res.status;
      throw err;
    }
    const data = await res.json();
    if (!Array.isArray(data.gloss) || !data.gloss.length) throw new Error("空結果");
    glossApiOnline = true;
    return { tokens: data.gloss, seconds: data.seconds };
  } finally {
    clearTimeout(timer);
  }
}

async function withTranslateRetry(attemptFn, onRetry = null) {
  for (let attempt = 0; ; attempt++) {
    try {
      return await attemptFn();
    } catch (err) {
      const delay = TRANSLATE_RETRY_DELAYS[attempt];
      if (delay === undefined || !TRANSLATE_RETRY_STATUS.has(err.status)) throw err;
      onRetry?.(attempt + 1, err);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Composer 走同源 /translate（回傳含 sign_ids 的完整結果，3D 虛擬人靠它取動作片段）
async function translateAttempt(sentence) {
  if (window.Composer?.translate) {
    try {
      const result = await Composer.translate(sentence);
      if (Array.isArray(result.glosses) && result.glosses.length) {
        return { tokens: result.glosses, source: "gemma", seconds: result.seconds, translation: result };
      }
    } catch (ex) {
      console.warn("Composer translate failed; trying direct API.", ex);
    }
  }
  // Composer 那條路丟的錯沒有 status，要靠這次 direct 呼叫決定值不值得重試
  const r = await translateOnce(sentence, 60000);
  return { tokens: r.tokens, source: "gemma", seconds: r.seconds, translation: null };
}

async function translateToSignOrder(sentence, onRetry = null) {
  try {
    return await withTranslateRetry(() => translateAttempt(sentence), onRetry);
  } catch (err) {
    glossApiOnline = false;
    return { tokens: convertToSignOrder(sentence), source: "fallback", error: err, translation: null };
  }
}

/* 狀態列平常掛著 visually-hidden，只講給螢幕閱讀器聽 —— 這是 0913/0914 兩次
   誤判的關鍵：翻譯降級成內建對照表時，「未連上語言模型」這行字確實有寫，
   但寫進了一個畫面上根本看不到的元素，現場沒有人知道那串詞卡不是模型翻的。
   所以只有出問題時才把它顯示出來，正常翻譯完成維持原本的安靜。*/
function setGenerationStatus(text, state = "ok") {
  generationStatus.textContent = text;
  generationStatus.dataset.state = state;
  generationStatus.classList.toggle("visually-hidden", state === "ok");
}

async function updateGeneration() {
  const sentence = textInput.value.trim();
  if (!sentence) {
    setGenerationStatus("請先輸入一句口語，例如：你好");
    originalSentence.textContent = "尚未輸入內容";
    currentGeneratedTokens = [];
    renderGenerationTokens([]);
    genPlayer.load([]);
    window.dispatchEvent(new CustomEvent("signavatar:generation-cleared"));
    return;
  }

  genPlayer.stop();
  currentGeneratedTokens = [];
  renderGenerationTokens([]);
  genPlayer.load([]);
  originalSentence.textContent = sentence;
  setGenerationStatus("語言模型翻譯中…");
  window.dispatchEvent(new CustomEvent("signavatar:generation-started", {
    detail: { sentence },
  }));

  const translated = await translateToSignOrder(sentence, attempt => {
    setGenerationStatus(`語言模型還沒就緒（可能正在載入），第 ${attempt} 次重試…`, "warn");
  });
  currentGeneratedTokens = translated.tokens;
  renderGenerationTokens(currentGeneratedTokens);
  genPlayer.load(currentGeneratedTokens);

  const offline = translated.error?.message || "離線";
  if (translated.source === "gemma") {
    setGenerationStatus(`語言模型（Gemma 4 微調）翻譯完成${translated.seconds ? `，耗時 ${translated.seconds}s` : ""}，正在接上虛擬人播放。`);
  } else if (currentGeneratedTokens.length) {
    setGenerationStatus(`⚠ 未連上語言模型（${offline}）。以下是離線對照表的結果，不是模型翻譯。`, "warn");
  } else {
    setGenerationStatus(`⚠ 未連上語言模型（${offline}），這一句無法翻譯。請先確認後端狀態，再重試一次。`, "warn");
  }
  window.dispatchEvent(new CustomEvent("signavatar:generation-updated", {
    detail: { sentence, tokens: currentGeneratedTokens, translation: translated.translation },
  }));
  // 翻不出來就不要叫虛擬人演：沒有詞卡時 playAvatarSequence 只會再蓋掉上面那句警告
  if (currentGeneratedTokens.length) playAvatarSequence();
}

function playAvatarSequence() {
  if (!currentGeneratedTokens.length) {
    setGenerationStatus("請先完成手語語序轉換，再播放虛擬人。");
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
});

videoModeButton.addEventListener("click", () => {
  useUploadMode();
  // 尚未載入影片時直接開檔案選取器，省一步
  if (!previewVideo.getAttribute("src")) videoUpload.click();
});
cameraModeButton.addEventListener("click", openCameraPreview);
document.querySelector("#startRecognition").addEventListener("click", startRecognition);

document.querySelector("#resetRecognition").addEventListener("click", () => {
  resetRecognitionSteps();
  renderTokens(recognitionTokens, []);
  spokenResult.textContent = "尚未辨識";
  setRecStatus("等待輸入", "idle");
  // 重置只清結果與辨識狀態，輸入來源留在原本的模式：
  // 攝影機模式串流照舊（未開啟就維持未開啟）；上傳模式清掉已載入的影片，回到「點擊新增影片」
  if (cameraModeButton.getAttribute("aria-pressed") !== "true") {
    stopCameraStream();
    clearUploadedVideo();
    previewVideo.srcObject = null;
    previewVideo.removeAttribute("src");
    showPreview(false);
  }
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
  setGenerationStatus(`正在單獨播放「${currentGeneratedTokens[index]}」的動作。`);
});

document.querySelector("#clearText").addEventListener("click", () => {
  genPlayer.stop();
  textInput.value = "";
  originalSentence.textContent = "尚未輸入內容";
  currentGeneratedTokens = [];
  renderGenerationTokens([]);
  genPlayer.load([]);
  setGenerationStatus("內容已清除，請重新輸入一句口語。");
  window.dispatchEvent(new CustomEvent("signavatar:generation-cleared"));
});

// ── 語音輸入：按住說話，放開後把 Gemini 轉出的文字填進輸入框 ──
// 不直接翻譯：聽錯一個字，後面的語序與詞卡全跟著錯，所以先讓人看過、
// 改過，再自己按「轉成手語」。
const micButton = document.querySelector("#micInput");
const MIC_MAX_MS = 15000;  // 後端只收 15 秒左右的量，到點自動送出
const MIC_MIN_MS = 400;    // 短於這個多半是點一下，不是在說話
let micSession = null;     // { recorder, startedAt, timer }
let micHeld = false;

function transcribeUrl() {
  return (window.SignAvatarConfig || {}).transcribeUrl || "transcribe";
}

function setMicState(state) {
  micButton.dataset.state = state;
  micButton.disabled = state === "busy";
  micButton.querySelector("span").textContent =
    // 三種狀態都是四個字：字數一變，同排的「清除」就會被擠到下一行
    state === "recording" ? "放開送出" : state === "busy" ? "辨識中…" : "按住說話";
}

async function startMic() {
  if (micSession || micButton.disabled) return;
  micHeld = true;
  let stream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: true, noiseSuppression: true },
    });
  } catch {
    setGenerationStatus("⚠ 沒有取得麥克風權限。請在瀏覽器允許使用麥克風，或改用打字輸入。", "warn");
    return;
  }
  // 第一次用會先跳權限詢問，按下「允許」時手早就放開了：這次不錄，請他再按住一次
  if (!micHeld) {
    stream.getTracks().forEach(track => track.stop());
    setGenerationStatus("麥克風已開啟。請按住「按住說話」說一句話，說完再放開。", "warn");
    return;
  }
  const mimeType = ["audio/webm;codecs=opus", "audio/ogg;codecs=opus", "audio/mp4"]
    .find(type => MediaRecorder.isTypeSupported(type));
  const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32000 });
  const chunks = [];
  const session = { recorder, startedAt: performance.now(), timer: setTimeout(stopMic, MIC_MAX_MS) };
  recorder.addEventListener("dataavailable", e => { if (e.data.size) chunks.push(e.data); });
  recorder.addEventListener("stop", () => {
    stream.getTracks().forEach(track => track.stop());
    const blob = new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" });
    if (performance.now() - session.startedAt < MIC_MIN_MS || !blob.size) {
      setMicState("idle");
      setGenerationStatus("請按住「按住說話」不放，說完一句話再放開。", "warn");
      return;
    }
    sendRecording(blob);
  });
  micSession = session;
  recorder.start();
  setMicState("recording");
}

function stopMic() {
  micHeld = false;
  if (!micSession) return;
  clearTimeout(micSession.timer);
  const { recorder } = micSession;
  micSession = null;
  if (recorder.state !== "inactive") recorder.stop();
}

async function sendRecording(blob) {
  setMicState("busy");
  setGenerationStatus("語音辨識中…");
  try {
    const res = await fetch(transcribeUrl(), {
      method: "POST",
      headers: { "Content-Type": blob.type },
      body: blob,
    });
    const data = await res.json().catch(() => ({}));
    // 後端的錯誤訊息是寫給使用者看的完整句子（含下一步），原樣顯示
    if (!res.ok) throw new Error(data.error || `語音辨識服務沒有回應（HTTP ${res.status}），請改用打字輸入。`);
    if (!data.text) {
      setGenerationStatus("沒有聽清楚，請靠近麥克風再說一次。", "warn");
      return;
    }
    textInput.value = data.text;
    textInput.focus();
    setGenerationStatus("已轉成文字，確認沒錯再按「轉成手語」。");
  } catch (ex) {
    // fetch 本身丟的 TypeError 是連線層的（tunnel 斷了、離線），訊息是英文，換掉
    const reason = ex instanceof TypeError ? "連不上語音辨識服務，請改用打字輸入。" : ex.message;
    setGenerationStatus(`⚠ ${reason}`, "warn");
  } finally {
    setMicState("idle");
  }
}

// 沒有麥克風 API 的環境（http 非本機、舊瀏覽器、部分 App 內建瀏覽器）就不顯示按鈕
if (micButton && navigator.mediaDevices?.getUserMedia && window.MediaRecorder) {
  micButton.hidden = false;
  micButton.addEventListener("pointerdown", e => {
    if (e.button !== 0) return;
    e.preventDefault();
    micButton.setPointerCapture?.(e.pointerId);  // 手指滑出按鈕也算還按著
    startMic();
  });
  micButton.addEventListener("pointerup", stopMic);
  micButton.addEventListener("pointercancel", stopMic);
  micButton.addEventListener("contextmenu", e => e.preventDefault());
  // 鍵盤：在按鈕上按住空白鍵或 Enter 說話（全域快捷鍵遇到按鈕會讓給這裡）
  micButton.addEventListener("keydown", e => {
    if ((e.key === " " || e.key === "Enter") && !e.repeat) { e.preventDefault(); startMic(); }
  });
  micButton.addEventListener("keyup", e => {
    if (e.key === " " || e.key === "Enter") { e.preventDefault(); stopMic(); }
  });
}

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


// ── 辨識頁預設即時攝影機：進頁時沒有任何影像來源就直接開鏡頭 ──
function autoOpenCamera() {
  const hasSource = Boolean(currentStream) || Boolean(previewVideo.getAttribute("src"));
  if (!hasSource) openCameraPreview();
}
window.addEventListener("pagechange", e => { if (e.detail === "recognition") autoOpenCamera(); });
if (!document.querySelector("#recognition").hidden) autoOpenCamera();
