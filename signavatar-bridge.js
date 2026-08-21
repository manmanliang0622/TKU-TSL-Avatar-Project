"use strict";

const stage = document.querySelector("#signAvatarStage");
const stageWrap = stage?.closest(".avatar-stage");
// the transport controls are positioned against .avatar-wrap, not the stage
// itself, so the dock that now holds them has to live in the same box
const stageOuter = stage?.closest(".avatar-wrap") || stageWrap;
const textInput = document.querySelector("#textInput");
const startButton = document.querySelector("#startPlayback");
const pauseButton = document.querySelector("#pausePlayback");
const clearButton = document.querySelector("#clearText");
const generationTokens = document.querySelector("#generationTokens");
const generationStatus = document.querySelector("#generationStatus");
const avatarStatus = document.querySelector("#avatarStatus");

let lexicon = {};
let composed = null;
let playing = false;
let paused = false;
let playhead = 0;
let playbackRate = 1;
let lastTs = performance.now();
let ready = false;
let initPromise = null;
let buildToken = 0;          // 只認最後一次請求，舊的組完就丟掉
/* 「這一句是哪些詞」和「現在載進來的是哪些詞」是兩件事，必須分開記。
   單獨播一個詞卡會把 composed 換成那一個詞——如果只看 composed，按下播放
   就只會一直重播那個詞，整句再也回不來。 */
let sentenceTokens = [];
let composedTokens = [];
const camera = { yaw: 0, pitch: 0.03, dist: 1.4 };

function visibleTokens() {
  return [...(generationTokens?.querySelectorAll("[data-token-index], .token") || [])]
    .map(el => el.textContent.trim())
    .filter(Boolean);
}

function setStatus(text) {
  if (avatarStatus) avatarStatus.textContent = text;
}

function setNote(text) {
  if (generationStatus) generationStatus.textContent = text;
}

/* ── loading overlay ─────────────────────────────────────────────────
 * Two waits sit between pressing the button and the avatar moving: the
 * model writing the gloss (about four seconds), then the clips for those
 * glosses arriving. Both used to be silent — the stage just sat there with
 * a motionless avatar, which reads as "broken" rather than "working".
 *
 * So the overlay covers BOTH, names which one is running, and counts the
 * clips as they land. Work is registered by key rather than by depth, so
 * the gloss stage handing over to the clip stage never blinks.
 *
 * The icon is a hand: a single silhouette, fingers rooted in the palm
 * behind a webbed knuckle line, waving one after another. Earlier it
 * folded fingers by scaling them to stubs, which broke the hand into five
 * floating pieces on every beat — the opposite of what a sign language
 * product should show. Nothing here is an image file, so it draws
 * instantly and stays sharp at any size. */
const HAND_SVG = `
<svg class="sa-hand" viewBox="0 0 64 80" aria-hidden="true">
  <defs>
    <radialGradient id="sa-glow">
      <stop offset="0%" stop-color="rgba(255,255,255,.30)"/>
      <stop offset="100%" stop-color="rgba(255,255,255,0)"/>
    </radialGradient>
  </defs>
  <circle cx="34" cy="44" r="30" fill="url(#sa-glow)"/>
  <!-- Fingers first, and their roots run 9 units below the knuckle line: the
       palm is painted over them, so a finger that moves can never come away
       from the hand. They sit on a knuckle arc — middle tallest, little
       shortest and set lower — because a row of equal fingers reads as a
       comb. -->
  <path class="fg f1" d="M20.6 47 L21.2 20.8 A3.4 3.4 0 0 1 27.8 20.8 L28.0 47 Z"/>
  <path class="fg f2" d="M29.2 47 L29.7 15.6 A3.5 3.5 0 0 1 36.3 15.6 L36.5 47 Z"/>
  <path class="fg f3" d="M37.7 47 L38.2 19.4 A3.4 3.4 0 0 1 44.6 19.4 L44.8 47 Z"/>
  <path class="fg f4" d="M46.0 47 L46.4 26.6 A3.0 3.0 0 0 1 52.0 26.6 L52.1 47 Z"/>
  <!-- Thumb: it leaves the palm at the heel, where a thumb does. The splay
       lives on the wrapper, because a CSS transform on the path itself would
       REPLACE this rotate rather than compose with it. -->
  <g class="sa-thumb" transform="rotate(-42 26 56)">
    <path class="fg f5" d="M19.6 57 L20.2 38.6 A3.6 3.6 0 0 1 27.0 38.6 L27.2 57 Z"/>
  </g>
  <!-- Palm: the knuckle line is scalloped, so the fingers rise out of webbing
       the way they do on a hand instead of standing on a flat edge, and the
       sides curve in to a wrist rather than running straight down — a
       straight taper reads as a paddle. -->
  <path class="palm" d="M18.6 44.8
    Q19.4 38.6 23.6 38.2 Q26.6 37.9 28.4 38.2
    Q30.8 37.6 32.8 37.6 Q35.0 37.6 37.0 38.2
    Q39.2 37.9 42.0 38.3 Q46.0 38.8 47.4 41.0
    Q49.8 44.4 50.2 49.4
    C50.9 57.0 49.4 63.0 46.4 66.6
    Q43.6 69.9 37.2 70.0 L29.4 70.0
    Q23.2 69.9 21.0 66.6 C18.2 62.4 17.8 52.2 18.6 44.8 Z"/>
</svg>`;

let loadingEl = null;
const loadingJobs = new Map();   // key → label

function ensureLoadingOverlay() {
  if (loadingEl || !stageWrap) return loadingEl;
  loadingEl = document.querySelector("#avatarLoading") || document.createElement("div");
  loadingEl.id = "avatarLoading";
  loadingEl.className = "avatar-loading";
  loadingEl.setAttribute("role", "status");
  loadingEl.setAttribute("aria-live", "polite");
  loadingEl.innerHTML = `
    <div class="sa-loading-icon">
      <svg class="sa-ring" viewBox="0 0 100 100" aria-hidden="true">
        <circle class="sa-ring-track" cx="50" cy="50" r="45"/>
        <circle class="sa-ring-arc" cx="50" cy="50" r="45"/>
      </svg>
      ${HAND_SVG}
    </div>
    <span class="sa-label"></span>`;
  if (!loadingEl.parentNode) stageWrap.appendChild(loadingEl);
  loadingEl.hidden = true;
  return loadingEl;
}

function paintLoading() {
  const el = ensureLoadingOverlay();
  if (!el) return;
  const label = [...loadingJobs.values()].pop();
  if (!label) {
    el.classList.add("is-out");
    setTimeout(() => { if (!loadingJobs.size) el.hidden = true; }, 200);
    return;
  }
  const text = el.querySelector(".sa-label");
  if (text) text.innerHTML = `${label}<span class="sa-dots"></span>`;
  el.hidden = false;
  // reading it back forces the transition to restart from opacity 0
  void el.offsetWidth;
  el.classList.remove("is-out");
}

function beginLoading(key, label) {
  loadingJobs.set(key, label);
  paintLoading();
}

function endLoading(key) {
  loadingJobs.delete(key);
  paintLoading();
}

/* ring progress: 0-1 while clips arrive, indeterminate when unknown */
function setLoadingProgress(fraction) {
  const el = ensureLoadingOverlay();
  if (!el) return;
  if (fraction === null) {
    el.classList.add("is-indeterminate");
    el.style.removeProperty("--sa-progress");
    return;
  }
  el.classList.remove("is-indeterminate");
  el.style.setProperty("--sa-progress", String(Math.min(1, Math.max(0, fraction))));
}

async function withLoading(key, label, fn) {
  beginLoading(key, label);
  try {
    return await fn();
  } finally {
    endLoading(key);
  }
}

/* ── orbit the stage ─────────────────────────────────────────────────
 * A sign is a 3D object and a fixed front view hides half of it: handshapes
 * that point toward the camera, and any contact between the hand and the body,
 * are only readable from the side. Drag to rotate, wheel or pinch to zoom,
 * double-click to go back to the front.
 *
 * Drags that start on the transport controls are ignored, since those sit
 * inside the stage; and touchAction is cleared so a drag on a phone rotates
 * the avatar rather than scrolling the page. */
const CAM_HOME = { yaw: 0, pitch: 0.03, dist: 1.4 };
const PITCH_LIMIT = [-0.5, 0.7];
const DIST_LIMIT = [0.8, 2.4];
let orbitAttached = false;

function attachOrbit() {
  if (orbitAttached || !stageWrap) return;
  orbitAttached = true;
  let dragging = false, lastX = 0, lastY = 0;
  const clamp = (v, [lo, hi]) => Math.min(hi, Math.max(lo, v));

  stageWrap.style.touchAction = "none";
  stageWrap.style.cursor = "grab";
  stageWrap.title = "拖曳可旋轉視角，滾輪縮放，雙擊回正";

  stageWrap.addEventListener("pointerdown", e => {
    if (e.target.closest("button, a, input, select, .player-toolbar, .stage-dock")) return;
    dragging = true;
    lastX = e.clientX;
    lastY = e.clientY;
    stageWrap.setPointerCapture(e.pointerId);
    stageWrap.style.cursor = "grabbing";
  });
  stageWrap.addEventListener("pointermove", e => {
    if (!dragging) return;
    camera.yaw += (e.clientX - lastX) * 0.008;
    camera.pitch = clamp(camera.pitch + (e.clientY - lastY) * 0.005, PITCH_LIMIT);
    lastX = e.clientX;
    lastY = e.clientY;
  });
  const endDrag = e => {
    if (!dragging) return;
    dragging = false;
    stageWrap.style.cursor = "grab";
    try { stageWrap.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
  };
  stageWrap.addEventListener("pointerup", endDrag);
  stageWrap.addEventListener("pointercancel", endDrag);
  stageWrap.addEventListener("wheel", e => {
    e.preventDefault();
    camera.dist = clamp(camera.dist + e.deltaY * 0.0012, DIST_LIMIT);
  }, { passive: false });
  stageWrap.addEventListener("dblclick", () => Object.assign(camera, CAM_HOME));
}

/* ── timeline ────────────────────────────────────────────────────────
 * A sentence is four seconds of continuous motion, and "play it again and
 * watch harder" is not a way to study a sign. The bar divides the sentence
 * into its words, so a viewer can go straight to the one they want and stop
 * on it — click a block, or drag the head and read the word off the label.
 *
 * It lives INSIDE the stage, in the same absolutely positioned dock as the
 * transport controls, for a reason beyond looks: the generation page is
 * sized to exactly one viewport, and anything added to the normal flow
 * would push it past that and start the page scrolling. An overlay costs
 * no layout height, so the page still ends where the window ends. */
let dock = null, track = null, fill = null, segsEl = null, headEl = null;
let timeNow = null, timeTotal = null, tokenLabel = null;
let scrubbing = false;
let currentSegments = [];

const fmtTime = t => `${Math.floor(t / 60)}:${(t % 60).toFixed(1).padStart(4, "0")}`;

function duration() {
  const frames = composed?.frames;
  return frames?.length ? frames[frames.length - 1].timestamp : 0;
}

/* [{token, start, end}] covering the WHOLE sentence.
 *
 * Only the frames of a sign itself carry a token; the rest holds at each end
 * and the cross-fades between words do not. Leaving those as gaps made a bar
 * of islands with dead space between them, and a click in the dead space
 * landed nowhere in particular. So every frame is given to its nearest word:
 * a cross-fade is split down the middle between the two words it joins, and
 * the bookends belong to the first and last word — which is right, because
 * the lead-in to 「我」 is the arm rising to sign 「我」. */
function segments() {
  const frames = composed?.frames || [];
  const runs = [];
  for (const frame of frames) {
    const token = frame._tok || null;
    const last = runs[runs.length - 1];
    if (last && last.token === token) last.end = frame.timestamp;
    else runs.push({ token, start: frame.timestamp, end: frame.timestamp });
  }
  const words = runs.filter(run => run.token);
  if (!words.length) return [];
  const total = duration();
  words[0].start = 0;
  words[words.length - 1].end = total;
  for (let i = 1; i < words.length; i++) {
    const seam = (words[i - 1].end + words[i].start) / 2;
    words[i - 1].end = seam;
    words[i].start = seam;
  }
  return words;
}

function buildTimeline() {
  if (!stageOuter || dock) return;
  const toolbar = stageOuter.querySelector(".player-toolbar");
  dock = document.createElement("div");
  dock.className = "stage-dock";
  dock.innerHTML = `
    <div class="stage-timeline" hidden>
      <div class="timeline-meta">
        <span class="timeline-token" id="timelineToken">--</span>
        <span class="timeline-clock"><b id="timelineNow">0:00.0</b> / <span id="timelineTotal">0:00.0</span></span>
      </div>
      <div class="timeline-track" id="timelineTrack" role="slider" tabindex="0"
           aria-label="播放進度，可拖曳停在想看的動作"
           aria-valuemin="0" aria-valuemax="0" aria-valuenow="0" aria-valuetext="0.0 秒">
        <div class="timeline-segs" id="timelineSegs"></div>
        <div class="timeline-fill" id="timelineFill"></div>
        <div class="timeline-head" id="timelineHead"></div>
      </div>
    </div>`;
  stageOuter.appendChild(dock);
  // the bar goes last, so it sits along the very bottom edge of the stage
  // with the transport controls above it
  if (toolbar) dock.insertBefore(toolbar, dock.firstElementChild);

  track = dock.querySelector("#timelineTrack");
  fill = dock.querySelector("#timelineFill");
  segsEl = dock.querySelector("#timelineSegs");
  headEl = dock.querySelector("#timelineHead");
  timeNow = dock.querySelector("#timelineNow");
  timeTotal = dock.querySelector("#timelineTotal");
  tokenLabel = dock.querySelector("#timelineToken");
  attachScrub();
}

function renderSegments() {
  if (!segsEl) return;
  const total = duration();
  segsEl.innerHTML = "";
  currentSegments = total > 0 ? segments() : [];
  dock.querySelector(".stage-timeline").hidden = !(total > 0);
  if (!(total > 0)) return;
  for (const seg of currentSegments) {
    const block = document.createElement("div");
    block.className = "timeline-seg";
    block.setAttribute("aria-hidden", "true");
    block.style.left = `${(seg.start / total) * 100}%`;
    block.style.width = `${Math.max(0.6, ((seg.end - seg.start) / total) * 100)}%`;
    block.dataset.start = String(seg.start);
    block.title = `跳到「${seg.token}」`;
    block.innerHTML = `<span>${seg.token}</span>`;
    segsEl.appendChild(block);
  }
  if (timeTotal) timeTotal.textContent = fmtTime(total);
  if (track) {
    track.setAttribute("aria-valuemax", total.toFixed(1));
    track.setAttribute("aria-valuemin", "0");
  }
}

function paintTimeline() {
  if (!fill) return;
  const total = duration();
  const pct = total > 0 ? (playhead / total) * 100 : 0;
  fill.style.width = `${pct}%`;
  headEl.style.left = `${pct}%`;
  if (timeNow) timeNow.textContent = fmtTime(Math.min(playhead, total));
  const here = currentSegments.find((seg, i) =>
    playhead >= seg.start && (playhead < seg.end || i === currentSegments.length - 1));
  if (tokenLabel) tokenLabel.textContent = here?.token || (total > 0 ? "—" : "--");
  if (track) {
    track.setAttribute("aria-valuenow", playhead.toFixed(1));
    track.setAttribute("aria-valuetext", `${playhead.toFixed(1)} 秒${here ? `，${here.token}` : ""}`);
  }
  [...(segsEl?.children || [])].forEach((block, i) => {
    block.classList.toggle("is-current", currentSegments[i] === here);
  });
}

function seek(seconds) {
  const total = duration();
  playhead = Math.min(total, Math.max(0, seconds));
  paintTimeline();
}

function attachScrub() {
  const seekFromX = clientX => {
    const rect = track.getBoundingClientRect();
    if (!rect.width) return;
    seek(((clientX - rect.left) / rect.width) * duration());
  };

  track.addEventListener("pointerdown", e => {
    if (!duration()) return;
    // a click on a word block goes to the START of that word, not to that
    // pixel: the point of the bar is to stop ON a sign, and a sign is worth
    // watching from its beginning
    const block = e.target.closest(".timeline-seg");
    scrubbing = true;
    playing = false;
    track.setPointerCapture(e.pointerId);
    if (block) seek(Number(block.dataset.start));
    else seekFromX(e.clientX);
    e.preventDefault();
  });
  track.addEventListener("pointermove", e => { if (scrubbing) seekFromX(e.clientX); });
  const stop = e => {
    if (!scrubbing) return;
    scrubbing = false;
    try { track.releasePointerCapture(e.pointerId); } catch { /* already gone */ }
    // held, not resumed. Someone who reached for the bar wants to look at
    // this frame; play carries on when they press play.
    paused = true;
    setStatus("已停在此動作");
  };
  track.addEventListener("pointerup", stop);
  track.addEventListener("pointercancel", stop);

  track.addEventListener("keydown", e => {
    const total = duration();
    if (!total) return;
    const step = e.shiftKey ? 1 : 0.1;
    const jump = {
      ArrowLeft: -step, ArrowRight: step,
      ArrowDown: -step, ArrowUp: step,
      PageDown: -1, PageUp: 1,
    }[e.key];
    if (jump !== undefined) { seek(playhead + jump); playing = false; paused = true; }
    else if (e.key === "Home") { seek(0); playing = false; paused = true; }
    else if (e.key === "End") { seek(total); playing = false; paused = true; }
    else return;
    e.preventDefault();
    setStatus("已停在此動作");
  });
}

function frameAt(t) {
  if (!composed?.frames?.length) return null;
  const frames = composed.frames;
  let lo = 0;
  let hi = frames.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (frames[mid].timestamp < t) lo = mid + 1;
    else hi = mid;
  }
  return frames[Math.max(0, lo - 1)];
}

function resizeStage() {
  if (!ready || !stageWrap) return;
  Avatar3D.resize(stageWrap.clientWidth, stageWrap.clientHeight);
}

async function waitForAvatar() {
  while (!window.Avatar3D) await new Promise(resolve => setTimeout(resolve, 40));
}

async function initAvatar() {
  if (!stage || ready) return;
  await waitForAvatar();
  stageWrap?.classList.add("has-vrm");
  const lexiconPromise = Composer.loadLexicon();
  try {
    await Avatar3D.init(stage);
  } catch {
    setStatus("3D 模型載入失敗");
    return;
  }
  if (stageWrap) Avatar3D.resize(stageWrap.clientWidth, stageWrap.clientHeight);
  Avatar3D.setCamera(camera);
  Avatar3D.render();
  attachOrbit();
  buildTimeline();
  lexicon = await lexiconPromise;
  ready = true;
}

async function ensureAvatarReady() {
  if (ready) return;
  if (!initPromise) {
    setLoadingProgress(null);
    initPromise = withLoading("init", "虛擬人載入中", initAvatar).catch(err => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

function tokensFromFrontend() {
  // 模型輸出的 gloss 帶語料庫標註記號（買++、告訴(他)），直接查詞庫會落空、
  // 該詞就整個消失 —— 交給 Composer.resolve 去記號後再查
  return visibleTokens().filter(token => Composer.resolve(token, lexicon).length);
}

function tokensFromText() {
  const text = textInput?.value.trim() || "";
  if (!text) return [];
  return Composer.tokenize(text, lexicon).tokens;
}

/* ── prepare, then play ──────────────────────────────────────────────
 * Nothing starts moving until the WHOLE sentence is in hand. Half a
 * sentence is not a shorter sentence, it is a wrong one: the avatar would
 * sign two words, freeze mid-gesture while the third downloaded, then jump.
 *
 * Composer.build already waits for every clip before it stitches anything,
 * so the rule is really about what happens around it — the avatar stands at
 * rest, the overlay counts the clips in, and playback is armed in one step
 * at the end. A request that is superseded while it loads is dropped
 * rather than played late. */
async function prepare(tokens) {
  await ensureAvatarReady();
  if (!ready || !tokens.length) return null;
  const mine = ++buildToken;
  const clips = Composer.clipRequests(tokens, lexicon).length;
  setLoadingProgress(clips ? 0 : null);
  const built = await withLoading("clips", "動作載入中", () =>
    Composer.build(tokens, lexicon, null, (done, total) => {
      if (mine === buildToken && total) setLoadingProgress(done / total);
    }));
  if (mine !== buildToken) return null;   // a newer sentence overtook this one
  return built;
}

async function playTokens(tokens, statusText) {
  const built = await prepare(tokens);
  if (!built?.frames?.length) {
    if (!composed) setStatus("詞庫缺少對應動畫");
    return;
  }
  composed = built;
  composedTokens = [...tokens];
  playhead = 0;
  paused = false;
  playing = true;
  renderSegments();
  paintTimeline();
  setStatus(statusText);
  setNote("已接上 SignAvatar 3D 詞庫並播放。");
}

const sameTokens = (a, b) => a.length === b.length && a.every((token, i) => token === b[i]);

/* 整句要打的詞。以模型產出的那一句為準——畫面上的詞卡在播放中會被 2D 播放器
   重畫，讀 DOM 不可靠；沒有產出過才退回詞卡／輸入框。 */
function currentSentence() {
  if (sentenceTokens.length) return sentenceTokens;
  const shown = tokensFromFrontend();
  return shown.length ? shown : tokensFromText();
}

/* 整句播放。整句已經在手上就直接播（接著播，或播完了就從頭），
   剛剛是單詞試播就把整句組回來——片段都在快取裡，這一步大約 0.2 秒。 */
async function playWholeSentence() {
  const tokens = currentSentence();
  if (!tokens.length) return;
  if (composed && sameTokens(composedTokens, tokens)) {
    if (playhead >= duration()) playhead = 0;
    paused = false;
    playing = true;
    setStatus("3D 播放中");
    return;
  }
  await playTokens(tokens, "3D 播放中");
}

async function playSingleToken(index) {
  const token = visibleTokens()[index];
  if (!token || !Composer.resolve(token, lexicon).length) return;
  await playTokens([token], `「${token}」3D 播放中`);
}

function clearSequence() {
  buildToken++;
  composed = null;
  composedTokens = [];
  sentenceTokens = [];
  playing = false;
  paused = false;
  playhead = 0;
  renderSegments();
  paintTimeline();
}

function tick(ts) {
  const dt = Math.min(0.05, (ts - lastTs) / 1000);
  lastTs = ts;
  if (ready) {
    if (playing && !paused && composed) {
      playhead += dt * playbackRate;
      const lastFrame = composed.frames[composed.frames.length - 1];
      if (lastFrame && playhead >= lastFrame.timestamp) {
        playhead = lastFrame.timestamp;
        playing = false;
        setStatus("播放完成");
      }
      paintTimeline();
    }
    Avatar3D.setCamera(camera);
    // with no sentence loaded there is no frame to show, and the bind pose is
    // a T-pose; stand at rest instead, which is also where playback starts
    if (composed) Avatar3D.update(frameAt(playhead), dt);
    else Avatar3D.idle(dt);
    Avatar3D.render();
  }
  requestAnimationFrame(tick);
}

window.addEventListener("signavatar:generation-started", () => {
  // the model takes about four seconds to write the gloss; say so, rather
  // than leaving the stage looking stalled
  //
  // The previous sentence goes now, not when the new one arrives: leaving it
  // loaded would show its word blocks on the bar while a different sentence
  // is being fetched, and leave the avatar holding its last frame. Cleared,
  // the avatar simply stands at rest until the new sentence can run.
  clearSequence();
  setLoadingProgress(null);
  beginLoading("gloss", "正在轉換手語語序");
  setStatus("3D 準備中");
  ensureAvatarReady().catch(err => {
    console.error(err);
    endLoading("gloss");
  });
});

window.addEventListener("signavatar:generation-updated", event => {
  endLoading("gloss");
  const tokens = Array.isArray(event.detail?.tokens) ? event.detail.tokens : [];
  sentenceTokens = [...tokens];   // 之後按整句播放就是回到這一句
  const skipped = tokens.filter(token => !Composer.resolve(token, lexicon).length);
  playTokens(tokens, "3D 播放中")
    .then(() => {
      if (skipped.length && composed) {
        setNote(`已播放整句；詞庫沒有的詞先跳過：${skipped.join("、")}`);
      }
    })
    .catch(err => {
      console.error(err);
      setStatus("3D playback failed");
    });
});

window.addEventListener("signavatar:generation-cleared", () => {
  endLoading("gloss");
  endLoading("clips");
  clearSequence();
  setStatus("");
});

startButton?.addEventListener("click", () => {
  playWholeSentence().catch(err => {
    console.error(err);
    setStatus("3D 播放失敗");
  });
});

pauseButton?.addEventListener("click", () => {
  if (!composed) return;
  paused = true;
  playing = false;
  setStatus("3D 已暫停");
});

generationTokens?.addEventListener("click", event => {
  const button = event.target.closest("[data-token-index]");
  if (!button) return;
  playSingleToken(Number(button.dataset.tokenIndex)).catch(err => {
    console.error(err);
    setStatus("3D 單詞播放失敗");
  });
});

document.querySelectorAll(".speed-btn[data-rate]").forEach(button => {
  button.addEventListener("click", () => {
    playbackRate = Number(button.dataset.rate) || 1;
  });
});

clearButton?.addEventListener("click", clearSequence);

window.addEventListener("resize", resizeStage);
window.addEventListener("pagechange", event => {
  if (event.detail === "generation") setTimeout(resizeStage, 0);
});

ensureAvatarReady().catch(err => {
  console.error(err);
});
requestAnimationFrame(tick);
