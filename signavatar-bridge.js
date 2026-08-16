"use strict";

const stage = document.querySelector("#signAvatarStage");
const stageWrap = stage?.closest(".avatar-stage");
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
const camera = { yaw: 0, pitch: 0.03, dist: 1.4 };

function visibleTokens() {
  return [...(generationTokens?.querySelectorAll("[data-token-index], .token") || [])]
    .map(el => el.textContent.trim())
    .filter(Boolean);
}

function setStatus(text) {
  if (avatarStatus) avatarStatus.textContent = text;
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
    setStatus("3D \u6a21\u578b\u8f09\u5165\u5931\u6557");
    return;
  }
  if (stageWrap) Avatar3D.resize(stageWrap.clientWidth, stageWrap.clientHeight);
  Avatar3D.setCamera(camera);
  Avatar3D.render();
  lexicon = await lexiconPromise;
  ready = true;
}

async function ensureAvatarReady() {
  if (ready) return;
  if (!initPromise) {
    initPromise = initAvatar().catch(err => {
      initPromise = null;
      throw err;
    });
  }
  await initPromise;
}

function tokensFromFrontend() {
  return visibleTokens().filter(token => lexicon[token]);
}

function tokensFromText() {
  const text = textInput?.value.trim() || "";
  if (!text) return [];
  return Composer.tokenize(text, lexicon).tokens;
}

async function composeTokens(tokens) {
  await ensureAvatarReady();
  if (!ready || !tokens.length) return null;
  return Composer.build(tokens, lexicon);
}

async function playTokens(tokens, statusText) {
  const built = await composeTokens(tokens);
  if (!built?.frames?.length) {
    setStatus("詞庫缺少對應動畫");
    return;
  }
  composed = built;
  playhead = 0;
  paused = false;
  playing = true;
  setStatus(statusText);
  if (generationStatus) generationStatus.textContent = "已接上 SignAvatar 3D 詞庫並播放。";
}

async function playCurrentSequence() {
  const tokens = tokensFromFrontend();
  await playTokens(tokens.length ? tokens : tokensFromText(), "3D 播放中");
}

async function playSingleToken(index) {
  const token = visibleTokens()[index];
  if (!token || !lexicon[token]) return;
  await playTokens([token], `「${token}」3D 播放中`);
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
      }
    }
    Avatar3D.setCamera(camera);
    Avatar3D.update(frameAt(playhead), dt);
    Avatar3D.render();
  }
  requestAnimationFrame(tick);
}

window.addEventListener("signavatar:generation-started", event => {
  setStatus("3D \u6e96\u5099\u4e2d");
  ensureAvatarReady().catch(err => {
    console.error(err);
    
  });
});

window.addEventListener("signavatar:generation-updated", event => {
  const tokens = Array.isArray(event.detail?.tokens) ? event.detail.tokens : [];
  playTokens(tokens, "3D \u64ad\u653e\u4e2d").catch(err => {
    console.error(err);
    setStatus("3D playback failed");
  });
});

window.addEventListener("signavatar:generation-cleared", () => {
  composed = null;
  playing = false;
  paused = false;
  playhead = 0;
  setStatus("");
});

startButton?.addEventListener("click", () => {
  if (paused && composed) {
    paused = false;
    playing = true;
    setStatus("3D 繼續播放");
    return;
  }
  playCurrentSequence().catch(err => {
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

clearButton?.addEventListener("click", () => {
  composed = null;
  playing = false;
  paused = false;
  playhead = 0;
});

window.addEventListener("resize", resizeStage);
window.addEventListener("pagechange", event => {
  if (event.detail === "generation") setTimeout(resizeStage, 0);
});

ensureAvatarReady().catch(err => {
  console.error(err);
});
requestAnimationFrame(tick);
