/* Sign composer core: text → gloss tokens → stitched recording frames.
 *
 * Shared by viewer.html (compose panel) and generate.html (dedicated page).
 * Plain script exposing window.Composer; no DOM access in here.
 */
"use strict";

(() => {
  const COMPOSE_FPS = 30;
  const recordingCache = {}; // recording filename → parsed json

  async function loadLexicon() {
    for (const url of ["recordings/lexicon.json", "lexicon"]) {
      try {
        const res = await fetch(url, { cache: "no-store" });
        if (res.ok) return res.json();
      } catch {
        // Static hosting uses recordings/lexicon.json; the Python server also exposes /lexicon.
      }
    }
    return {};
  }

  function translateUrls() {
    const config = window.SignAvatarConfig || {};
    const urls = [];
    if (config.translateUrl) urls.push(config.translateUrl);
    if (Array.isArray(config.translateUrls)) urls.push(...config.translateUrls);
    urls.push("translate");
    return [...new Set(urls.filter(Boolean))];
  }

  async function translate(text) {
    let lastError = null;
    for (const url of translateUrls()) {
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text }),
        });
        if (!res.ok) {
          const err = await res.json().catch(() => ({}));
          throw new Error(err.error || `${url} ${res.status}`);
        }
        return res.json();
      } catch (ex) {
        lastError = ex;
      }
    }
    throw lastError || new Error("translate failed");
  }

  /* ── gloss → 詞庫鍵 ───────────────────────────────────────────────────
     語料庫的 gloss 帶標註記號:`買++` 是重複、`腳踝+這` 是複合、`告訴(他)`
     是一致性註記 —— 都不是詞的一部分,詞庫裡也不會有這種鍵。以前這種 gloss
     直接查不到:模型輸出那條路整個把它丟掉,手打文字那條路更糟,會逐字切分把
     `告訴(他)` 拆成 `告訴`+`他`,多打一個原文沒有的「他」。
     所以查詢前先去記號再試一次。純粹是查詢端的事,詞庫不必動。 */
  function stripMarkers(gloss) {
    const wrapped = gloss.match(/^\((.+)\)$/);      // (手勢) → 手勢,別整串刪掉
    let g = wrapped ? wrapped[1] : gloss;
    g = g.replace(/\([^)]*\)/g, "").replace(/\+\+$/, "");
    for (const sep of ["+", "→", "/", "~"]) g = g.split(sep)[0];
    return g.trim().replace(/^[，。？！?!,.、;；:：…「」『』]+|[，。？！?!,.、;；:：…「」『』]+$/g, "");
  }

  /* ── 複合詞 ────────────────────────────────────────────────────────
     有些 gloss 是把幾個既有動作連著打,詞庫不會有這個鍵,補拍也沒意義:
     `飛機起降` 就是 飛機→起飛→降落。逐字切分救不了 —— `起降` 不是詞,
     切出來會變成 `起`+`降` 兩個不相干的動作。所以這張表寫死,一條一條
     由人確認過語序才加進來;每一段都要在詞庫裡有動作,缺一段就整個不打
     (跟指拼同一個原則:寧可不動,也不要打出半句)。 */
  const COMPOUND = {
    "飛機起降": ["飛機", "起飛", "降落"],
  };

  /* ── 數字 ──────────────────────────────────────────────────────────
     語料庫把年份標成 2009、1924,台灣手語逐位打出(二/零/零/九),不是
     「兩千零九」。零一二…九 詞庫本來就有,所以這是純規則、不必拍片。
     注意:時刻也被標成純數字(9:32 → 932),逐位打對年份對、對時刻不一定對,
     但語料庫的 gloss 本身沒有拆分,無從得知演繹者怎麼打。目前只影響 4 次
     出現,先用同一條透明規則,並在 docs 標記待聾人顧問裁定。 */
  const DIGIT_SIGN = ["零", "一", "二", "三", "四", "五", "六", "七", "八", "九"];

  /* ── 指拼 ──────────────────────────────────────────────────────────
     沒有既定手語的外語詞(BB call、KTV、NIKE…)要逐字母拼。字母動作用
     `fs:A`…`fs:Z` 這組命名,刻意加 `fs:` 前綴,才不會跟詞庫裡真的叫 A、C
     的詞條撞名。**目前詞庫還沒有任何字母動作**(教育部辭典的英文字母只有
     手形圖、沒有影片,twtsl 也沒有),所以這條路現在一定回空 —— 等 26 個
     字母錄進來就會自動生效,不必再改程式。 */
  function fingerspell(word, lexicon) {
    const keys = [...word].map(ch => `fs:${ch.toUpperCase()}`);
    return keys.every(k => lexicon[k]) ? keys : [];
  }

  /* 大小寫索引:語料庫寫 Line,詞庫是 LINE / line;中文沒有大小寫,所以
     這個折疊只會影響含 ASCII 字母的鍵。實測 14,497 個鍵裡只有 3 組折疊後
     撞名(line/LINE、Email/EMAIL、youtube/YouTube),且每組兩邊同義,
     取排序第一個即可。索引建一次就快取,不然每個 token 都掃一遍詞庫。 */
  let foldedFor = null, foldedIdx = null;
  function foldedIndex(lexicon) {
    if (foldedFor === lexicon) return foldedIdx;
    const idx = new Map();
    for (const key of Object.keys(lexicon).sort()) {
      const bare = key.replace(/\s*[（(][^)）]*[)）]\s*/g, "").trim().toLowerCase();
      if (bare && !idx.has(bare)) idx.set(bare, key);
    }
    foldedFor = lexicon;
    foldedIdx = idx;
    return idx;
  }

  /* 這個 gloss 要打出哪幾個詞庫鍵;打不出來回空陣列。
     多半是一對一,數字與指拼會展開成多個。 */
  function resolve(gloss, lexicon) {
    if (!gloss) return [];
    if (lexicon[gloss]) return [gloss];
    const bare = stripMarkers(gloss);
    if (!bare) return [];
    if (lexicon[bare]) return [bare];
    const parts = COMPOUND[gloss] || COMPOUND[bare];
    if (parts) return parts.every(p => lexicon[p]) ? parts : [];
    if (/^[0-9]+$/.test(bare)) {
      const signs = [...bare].map(d => DIGIT_SIGN[+d]);
      return signs.every(s => lexicon[s]) ? signs : [];
    }
    if (/[A-Za-z]/.test(bare)) {
      const hit = foldedIndex(lexicon).get(bare.toLowerCase());
      if (hit) return [hit];
      if (/^[A-Za-z]+$/.test(bare)) return fingerspell(bare, lexicon);
    }
    return [];
  }

  /* greedy longest-match segmentation against lexicon keys (spaces also split) */
  function tokenize(text, lexicon) {
    const tokens = [], unknown = [];
    for (const chunk of text.trim().split(/[\s,，。.!！?？]+/).filter(Boolean)) {
      // 整塊先試:一個 gloss 本來就該當一個詞查,能整塊命中就不要進逐字切分
      const whole = resolve(chunk, lexicon);
      if (whole.length) { tokens.push(...whole); continue; }
      let i = 0;
      while (i < chunk.length) {
        let matched = null;
        for (let len = chunk.length - i; len >= 1; len--) {
          const cand = chunk.slice(i, i + len);
          if (lexicon[cand]) { matched = cand; break; }
        }
        if (matched) { tokens.push(matched); i += matched.length; }
        else { unknown.push(chunk[i]); i += 1; }
      }
    }
    return { tokens, unknown };
  }

  async function fetchRecordingByName(name) {
    if (recordingCache[name]) return recordingCache[name];
    // A recording is immutable once written, so let the browser keep it; the
    // old no-store re-downloaded 10-80 MB on every reload.
    const res = await fetch(`recordings/${encodeURIComponent(name)}`);
    if (!res.ok) throw new Error(`recording ${name} not found`);
    return (recordingCache[name] = await res.json());
  }

  /* ── clip fetching ───────────────────────────────────────────────────
   * A lexicon entry is 0.3-3 seconds out of a recording that runs for
   * minutes: 「我」 is 19 frames of a 2050-frame, 11.5 MB interview file.
   * Pulling the whole file to keep 0.9% of it was the single slowest step
   * in the pipeline — a three-word sentence downloaded 33 MB and spent
   * six seconds on it.
   *
   * The bundle server can cut the segment itself (POST /clips, one round
   * trip for the whole sentence). Static hosting cannot, so a failure here
   * falls back to the whole-file path and everything still works, just
   * slowly. Both paths return the same shape, so nothing downstream cares
   * which one ran. */
  const clipCache = {};          // "name|start|end" → sliced recording
  let clipEndpointOk = true;     // flipped off for hosts without the endpoint

  const clipKey = (name, start, end) => `${name}|${start}|${end}`;

  function clipUrls() {
    const config = window.SignAvatarConfig || {};
    const urls = [];
    if (config.clipsUrl) urls.push(config.clipsUrl);
    urls.push("clips");
    return [...new Set(urls.filter(Boolean))];
  }

  /* segments for a whole sentence at once; onProgress reports clips done */
  async function fetchSegments(requests, onProgress = null) {
    const wanted = [];
    const seen = new Set();
    for (const request of requests) {
      const key = clipKey(request.name, request.start, request.end);
      if (clipCache[key] || seen.has(key)) continue;
      seen.add(key);
      wanted.push(request);
    }
    const done = requests.length - wanted.length;
    if (onProgress) onProgress(done, requests.length);
    if (!wanted.length) return;

    if (clipEndpointOk) {
      for (const url of clipUrls()) {
        try {
          const res = await fetch(url, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ items: wanted }),
          });
          if (!res.ok) continue;
          const payload = await res.json();
          if (!Array.isArray(payload.clips)) continue;
          payload.clips.forEach((clip, i) => {
            if (clip) clipCache[clipKey(wanted[i].name, wanted[i].start, wanted[i].end)] = clip;
          });
          if (onProgress) onProgress(requests.length, requests.length);
          return;
        } catch {
          // fall through to the whole-file path below
        }
      }
      clipEndpointOk = false;
    }

    // no clip endpoint: fetch each distinct recording once and slice locally
    let finished = done;
    const byRecording = {};
    for (const request of wanted) {
      // 伺服器那台是 node 12，用不了 ||=（tests/composer_resolve.mjs 會載這支）
      if (!byRecording[request.name]) byRecording[request.name] = [];
      byRecording[request.name].push(request);
    }
    await Promise.all(Object.entries(byRecording).map(async ([name, group]) => {
      const recording = await fetchRecordingByName(name);
      for (const request of group) {
        clipCache[clipKey(name, request.start, request.end)] = {
          version: recording.version,
          label: recording.label,
          fps: recording.fps,
          source_width: recording.source_width,
          source_height: recording.source_height,
          created_at: recording.created_at,
          start: request.start,
          end: request.end,
          frames: sliceSegment(recording, request.start, request.end),
        };
        finished++;
        if (onProgress) onProgress(finished, requests.length);
      }
    }));
  }

  /* ── handedness repair ───────────────────────────────────────────────
   * MediaPipe's Left/Right label is classified per hand crop and is
   * documented to fail exactly where sign language lives: hands crossing,
   * touching, or near the frame edge (mediapipe#3902 "2 Left hands",
   * mediapipe#3047). Measured on 上樓, 25 frames contained 43 "Right" hands —
   * the two physical hands alternated into the same label, so the avatar's
   * right hand was fed the flat platform hand and the walking hand on
   * alternating frames and smoothed them into mush, while the left hand
   * starved (7/25 frames). The label is ignored whenever the POSE model's
   * wrists (tracked with temporal context, far more stable) can adjudicate:
   * each detected hand goes to the side whose pose wrist it sits on. */
  const HAND_MATCH_MAX = 0.12;     // image units; beyond this the pose wrist is not this hand
  const HAND_MATCH_MARGIN = 0.02;  // single-hand case: required gap between the two candidates

  function repairHandedness(frames) {
    for (const fr of frames) {
      const hs = fr.hands || [];
      if (!hs.length || !fr.pose || !fr.pose.landmarks) continue;
      const vis = fr.pose.visibility || [];
      const pw = { Left: fr.pose.landmarks[15], Right: fr.pose.landmarks[16] };
      const ok = { Left: (vis[15] == null ? 1 : vis[15]) > 0.5,
                   Right: (vis[16] == null ? 1 : vis[16]) > 0.5 };
      const d = (h, side) => { const w = h.landmarks[0], p = pw[side];
        return Math.hypot(w[0] - p[0], w[1] - p[1]); };
      if (hs.length === 1 && (ok.Left || ok.Right)) {
        const h = hs[0];
        const dl = ok.Left ? d(h, "Left") : Infinity;
        const dr = ok.Right ? d(h, "Right") : Infinity;
        if (Math.min(dl, dr) < HAND_MATCH_MAX && Math.abs(dl - dr) > HAND_MATCH_MARGIN)
          h.handedness = dl < dr ? "Left" : "Right";
      } else if (hs.length >= 2 && ok.Left && ok.Right) {
        const [h0, h1] = hs;
        const straight = d(h0, "Left") + d(h1, "Right");
        const crossed = d(h0, "Right") + d(h1, "Left");
        if (Math.min(straight, crossed) < 2 * HAND_MATCH_MAX) {
          if (straight <= crossed) { h0.handedness = "Left"; h1.handedness = "Right"; }
          else { h0.handedness = "Right"; h1.handedness = "Left"; }
        }
      }
    }
    return frames;
  }

  async function fetchSegment(name, start, end) {
    const key = clipKey(name, start, end);
    if (!clipCache[key]) await fetchSegments([{ name, start, end }]);
    const clip = clipCache[key] || null;
    if (clip && !clip._handsRepaired) {
      repairHandedness(clip.frames);
      clip._handsRepaired = true;
    }
    return clip;
  }

  function sliceSegment(recording, start, end) {
    return recording.frames.filter(f => f.timestamp >= start && f.timestamp <= end);
  }

  function lerp3(a, b, k) {
    return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
  }

  /* interpolate two frames (for the cross-fade between stitched signs) */
  function blendFrame(a, b, k) {
    const hands = [];
    for (const side of ["Left", "Right"]) {
      const ha = a.hands.find(h => h.handedness === side);
      const hb = b.hands.find(h => h.handedness === side);
      if (ha && hb)
        hands.push({
          handedness: side,
          score: Math.min(ha.score, hb.score),
          landmarks: ha.landmarks.map((p, i) => lerp3(p, hb.landmarks[i], k)),
          world_landmarks: ha.world_landmarks.map((p, i) => lerp3(p, hb.world_landmarks[i], k)),
        });
      else if (ha || hb) {
        const h = k < 0.5 ? ha : hb;
        if (h) hands.push(h);
      }
    }
    let pose = null;
    if (a.pose && b.pose)
      pose = {
        landmarks: a.pose.landmarks.map((p, i) => lerp3(p, b.pose.landmarks[i], k)),
        world_landmarks: a.pose.world_landmarks.map((p, i) => lerp3(p, b.pose.world_landmarks[i], k)),
        visibility: a.pose.visibility.map((v, i) => Math.min(v, b.pose.visibility[i])),
      };
    else pose = k < 0.5 ? a.pose : b.pose;
    let face = null;
    if (a.face && b.face) {
      const keys = new Set([...Object.keys(a.face.blendshapes), ...Object.keys(b.face.blendshapes)]);
      face = { blendshapes: {} };
      for (const key of keys) {
        const va = a.face.blendshapes[key] || 0, vb = b.face.blendshapes[key] || 0;
        face.blendshapes[key] = va + (vb - va) * k;
      }
    } else face = k < 0.5 ? a.face : b.face;
    return { hands, pose, face };
  }

  /* trim leading/trailing low-motion (neutral/idle) frames from a segment.
     Wrist speed in normalized image units/sec; a hand appearing or vanishing
     counts as activity so we never cut into the actual sign. Trim is capped
     at 25% of the segment (max 0.8s) per side and keeps ≥5 frames. */
  function trimNeutral(seg) {
    if (seg.length < 8) return seg;
    const activity = [];
    for (let i = 1; i < seg.length; i++) {
      let a = 0;
      const dt = Math.max(1e-3, seg[i].timestamp - seg[i - 1].timestamp);
      for (const side of ["Left", "Right"]) {
        const h1 = seg[i - 1].hands.find(h => h.handedness === side);
        const h2 = seg[i].hands.find(h => h.handedness === side);
        if (h1 && h2) {
          const [x1, y1] = h1.landmarks[0], [x2, y2] = h2.landmarks[0];
          a = Math.max(a, Math.hypot(x2 - x1, y2 - y1) / dt);
        } else if (h1 || h2) {
          a = Math.max(a, 1);  // hand entering/leaving frame = activity
        }
      }
      activity.push(a);
    }
    const THRESH = 0.12;
    const dur = seg[seg.length - 1].timestamp - seg[0].timestamp;
    const maxTrim = Math.min(0.8, dur * 0.25);
    let s = 0;
    while (s < activity.length && activity[s] < THRESH &&
           seg[s + 1].timestamp - seg[0].timestamp <= maxTrim) s++;
    let e = seg.length - 1;
    while (e > s + 1 && activity[e - 1] < THRESH &&
           seg[seg.length - 1].timestamp - seg[e - 1].timestamp <= maxTrim) e--;
    const out = seg.slice(s, e + 1);
    return out.length >= 5 ? out : seg;
  }

  /* ── rest-posture trimming ───────────────────────────────────────────
     Dictionary clips (twtsl) are standalone demos: the signer starts with
     both hands hanging at the sides, raises them, signs, then lowers them
     again. Measured across 250 twtsl clips, 40%+ of all frames sit in that
     rest cluster, and 父親/看/會 spend 55–63% of the clip there.

     trimNeutral cannot remove it: the raising/lowering stroke is FAST, so a
     speed threshold reads it as activity, and its ±0.8s cap is far short of
     the 1.6s lead-in a clip like 父親 carries. Result on stitched output:
     the avatar drops its hands to the sides between every sign.

     So we cut on POSTURE instead of speed. Wrist height is measured against
     the shoulder line and normalised by torso length, which makes it
     comparable across signers and camera distances:

         h = (shoulder_y − wrist_y) / (hip_y − shoulder_y)

     h ≈ −1.0 when the arm hangs at the side, h ≳ −0.2 while signing. The
     measured distribution is strongly bimodal with an empty band between,
     so ENTER = −0.65 separates the two cleanly with wide margin either way.

     Only the head and tail are cut — never the interior — so a sign that
     legitimately dips low mid-stroke is untouched. Corpus segments (moc/moe)
     that were cut from continuous signing never reach the rest band, so this
     is a no-op for them. */
  const REST_ENTER = -0.65;   // above this = hands are up and signing
  const REST_SETTLE = -0.35;  // ...and above this the hand has arrived
  const L_SHO = 11, R_SHO = 12, L_WRI = 15, R_WRI = 16, L_HIP = 23, R_HIP = 24;

  /* height of the higher wrist above the shoulder line, in torso units.
     null when the pose is missing or degenerate. */
  function wristHeight(frame) {
    const p = frame.pose;
    if (!p || !p.landmarks) return null;
    const lm = p.landmarks;
    const sho = lm[L_SHO], shoR = lm[R_SHO], hip = lm[L_HIP], hipR = lm[R_HIP];
    if (!sho || !shoR || !hip || !hipR) return null;
    const shoY = (sho[1] + shoR[1]) / 2;
    const torso = (hip[1] + hipR[1]) / 2 - shoY;
    if (!(torso > 1e-4)) return null;
    const lw = lm[L_WRI], rw = lm[R_WRI];
    if (!lw || !rw) return null;
    return Math.max((shoY - lw[1]) / torso, (shoY - rw[1]) / torso);
  }

  function trimRestPosture(seg) {
    if (seg.length < 8) return seg;
    const h = seg.map(wristHeight);
    if (h.every(v => v === null)) return seg;  // no pose data: leave it alone

    // first/last frame with the hands up in signing space
    let s = 0;
    while (s < seg.length && (h[s] === null || h[s] < REST_ENTER)) s++;
    let e = seg.length - 1;
    while (e > s && (h[e] === null || h[e] < REST_ENTER)) e--;
    if (s >= e) return seg;  // never leaves rest (or all-null): don't guess

    /* The threshold above only finds where the hand LEAVES rest, which is
       partway up the lead-in raise, not where the sign starts: measured on 要,
       the segment still began at wrist height -0.58 and climbed to -0.07
       before anything happened. The sequence now opens from a rest posture of
       its own, so that leftover climb played as a second raise - the hand
       lifted, then lifted again. Keep cutting while the wrist is still
       climbing into signing space, and the same on the way back down.
       Capped, so a sign that genuinely starts with an upward stroke keeps
       most of it. */
    const room = Math.floor((e - s) * 0.35);
    let s2 = s, e2 = e;
    while (s2 < s + room && h[s2] !== null && h[s2] < REST_SETTLE
           && h[s2 + 1] !== null && h[s2 + 1] > h[s2]) s2++;
    while (e2 > e - room && h[e2] !== null && h[e2] < REST_SETTLE
           && h[e2 - 1] !== null && h[e2 - 1] > h[e2]) e2--;
    if (e2 - s2 < 4) { s2 = s; e2 = e; }

    const out = seg.slice(s2, e2 + 1);
    return out.length >= 5 ? out : seg;
  }

  /* ── stable body scale ───────────────────────────────────────────────
     solveArm maps the signer's wrist into avatar space by normalising
     against shoulder width and torso length. Recomputed per frame those
     normalisers wobble with MediaPipe noise (shoulder width varies 3.4%
     frame-to-frame on 辣).

     Measured, that wobble accounts for ~0% of the wrist jitter — the raw
     wrist landmark dominates — so this is a correctness change, not the
     drift fix (the EMA in avatar3d.js is). It matters because the signer's
     skeleton cannot change size within a clip, and because stitched signs
     come from signers of different build: taking the median per SEGMENT
     (not globally) keeps each clip normalised against its own proportions
     while holding the divisor constant for the length of that sign. */
  function median(v) {
    if (!v.length) return null;
    const a = [...v].sort((x, y) => x - y);
    const m = a.length >> 1;
    return a.length % 2 ? a[m] : (a[m - 1] + a[m]) / 2;
  }

  function dist3(a, b) {
    return Math.hypot(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
  }

  function bodyScale(seg) {
    const widths = [], torsos = [];
    for (const f of seg) {
      const w = f.pose && f.pose.world_landmarks;
      if (!w || !w[L_SHO] || !w[R_SHO] || !w[L_HIP] || !w[R_HIP]) continue;
      widths.push(dist3(w[L_SHO], w[R_SHO]));
      const sMid = [0, 1, 2].map(i => (w[L_SHO][i] + w[R_SHO][i]) / 2);
      const hMid = [0, 1, 2].map(i => (w[L_HIP][i] + w[R_HIP][i]) / 2);
      torsos.push(dist3(sMid, hMid));
    }
    const width = median(widths), torso = median(torsos);
    if (!(width > 1e-3) || !(torso > 1e-3)) return null;
    return { width, torso };
  }

  /* ── tempo normalisation ─────────────────────────────────────────────
     The three sources were recorded for different purposes and sign at
     completely different speeds. Measured over 23 signs, median wrist speed
     while actually moving:

       twtsl (中正辭典 demos)   老師 0.09  辣 0.097  喜歡 0.162   — slow, taught
       moe  (教育部辭典)        謝謝 0.207
       moc  (文化部語料)        吃飯 0.79  媽媽 0.808            — natural, fast

     a 9x spread, and it tracks the SOURCE rather than the sign. Stitch them
     into one sentence and the avatar lurches between a lecture and a mumble.

     Speed is measured over moving frames only. Plain median duration or mean
     speed would mostly measure how much of a clip is a static hold — the
     dictionary clips hold for 55-66% of their length (movingFrac 0.34-0.44 on
     辣/喜歡 vs 1.00 on the corpus cuts) — so those metrics would rate a clip
     "slow" for pausing rather than for stroking slowly, and then compress the
     stroke to fix a pause.

     Each segment is resampled so its stroke speed lands on TEMPO_TARGET (the
     measured median). The scale is bounded: past these limits we would be
     inventing motion that was never recorded, and a sign that is genuinely
     long — 辣 repeats its stroke several times, and repetition can be
     grammatical in TSL — should get faster, not truncated. Resampling also
     puts every segment on COMPOSE_FPS; source clips run at their own rate
     (玩 was recorded at ~60fps), which was a second source of unevenness. */
  const TEMPO_TARGET = 0.38;   // normalized image units of wrist path per second
  const TEMPO_MIN = 0.3;       // never compress a segment past 3.3x
  const TEMPO_MAX = 2.5;       // never stretch one past 2.5x
  const TEMPO_MIN_SEC = 0.35;  // ...and never leave a sign too brief to read
  const TEMPO_MAX_SEC = 2.6;

  /* Total wrist path divided by duration.
     The obvious alternative — median speed over "moving" frames — was tried
     and is wrong here, because a fixed speed threshold is not scale
     invariant: speeding a clip up lifts its HOLD frames above the threshold,
     they join the average, and the measured speed falls back down. Hold-heavy
     dictionary clips (辣 holds for 56% of its length) therefore never
     converged — 辣 came out at 0.09 both before and after normalising.
     Path over duration has no threshold and scales exactly: halve the
     duration and it doubles, so one pass lands on the target. */
  function meanSpeed(seg) {
    const dur = seg[seg.length - 1].timestamp - seg[0].timestamp;
    if (!(dur > 1e-3)) return null;
    let path = 0;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1].pose && seg[i - 1].pose.landmarks;
      const b = seg[i].pose && seg[i].pose.landmarks;
      if (!a || !b) continue;
      let m = 0;
      for (const idx of [L_WRI, R_WRI]) {
        if (!a[idx] || !b[idx]) continue;
        m = Math.max(m, Math.hypot(b[idx][0] - a[idx][0], b[idx][1] - a[idx][1]));
      }
      path += m;
    }
    return path / dur;
  }

  /* resample a segment onto a new duration, keeping COMPOSE_FPS */
  function retime(seg, scale) {
    if (seg.length < 3 || Math.abs(scale - 1) < 0.03) return seg;
    const t0 = seg[0].timestamp;
    const dur = seg[seg.length - 1].timestamp - t0;
    if (!(dur > 1e-3)) return seg;
    const outDur = dur * scale;
    const n = Math.max(2, Math.round(outDur * COMPOSE_FPS));
    const out = [];
    let j = 0;
    for (let i = 0; i <= n; i++) {
      const u = i / n;
      const st = t0 + u * dur;
      while (j < seg.length - 2 && seg[j + 1].timestamp < st) j++;
      const a = seg[j], b = seg[j + 1] || seg[j];
      const span = Math.max(1e-6, b.timestamp - a.timestamp);
      const k = Math.min(1, Math.max(0, (st - a.timestamp) / span));
      out.push({ ...blendFrame(a, b, k), timestamp: t0 + u * outDur });
    }
    return out;
  }

  /* Speed alone is not enough to decide a duration. 家 covers very little
     ground in 0.35s, so matching its speed to the target would compress it to
     0.13s — four frames, unreadable. The duration bound is what stops a sign
     with little movement from vanishing, and a long one from dragging. */
  function normalizeTempo(seg) {
    const speed = meanSpeed(seg);
    if (!speed || seg.length < 3) return seg;
    const dur = seg[seg.length - 1].timestamp - seg[0].timestamp;
    let scale = Math.min(TEMPO_MAX, Math.max(TEMPO_MIN, speed / TEMPO_TARGET));
    scale = Math.min(Math.max(scale, TEMPO_MIN_SEC / dur), TEMPO_MAX_SEC / dur);
    return retime(seg, scale);
  }

  /* transition length scales with how far the hands must travel (epenthesis) */
  function wristDistance(a, b) {
    let sum = 0, n = 0;
    for (const side of ["Left", "Right"]) {
      const ha = a.hands.find(h => h.handedness === side);
      const hb = b.hands.find(h => h.handedness === side);
      if (ha && hb) {
        const [ax, ay] = ha.landmarks[0], [bx, by] = hb.landmarks[0];
        sum += Math.hypot(bx - ax, by - ay);
        n++;
      }
    }
    return n ? sum / n : 0.25;
  }

  function blendSeconds(a, b) {
    return Math.min(0.55, Math.max(0.12, 0.12 + wristDistance(a, b) * 0.9));
  }

  /* non-manual markers: brows carry the question, a headshake carries negation */
  const NEG_GLOSSES = new Set(["沒辦法", "沒有", "不要", "別", "不會", "不能", "不行", "不"]);

  function applyNMM(frames, tags, tokens) {
    if (!tags || !frames.length) return;
    const lastTok = tokens[tokens.length - 1];
    if (tags.question === "yesno" || tags.question === "wh") {
      for (const f of frames) {
        if (f._tok !== lastTok) continue;
        const bs = { ...((f.face && f.face.blendshapes) || {}) };  // copy: frames share cached objects
        if (tags.question === "yesno") {
          bs.browInnerUp = Math.max(bs.browInnerUp || 0, 0.7);
          bs.browOuterUpLeft = Math.max(bs.browOuterUpLeft || 0, 0.5);
          bs.browOuterUpRight = Math.max(bs.browOuterUpRight || 0, 0.5);
        } else {
          bs.browDownLeft = Math.max(bs.browDownLeft || 0, 0.7);
          bs.browDownRight = Math.max(bs.browDownRight || 0, 0.7);
        }
        f.face = { blendshapes: bs };
      }
    }
    if (tags.negation) {
      const negTok = tokens.filter(tok => NEG_GLOSSES.has(tok)).pop() || lastTok;
      for (const f of frames) {
        if (f._tok !== negTok || !f.pose) continue;
        const dx = 0.03 * Math.sin(2 * Math.PI * 3 * f.timestamp);  // ~3Hz headshake
        const pose = {  // copy before mutating: pose arrays are shared with the cache
          landmarks: f.pose.landmarks.map(p => [...p]),
          world_landmarks: f.pose.world_landmarks.map(p => [...p]),
          visibility: f.pose.visibility,
        };
        for (const idx of [0, 7, 8]) {  // nose + both ears → head yaw
          if (pose.landmarks[idx]) pose.landmarks[idx][0] += dx;
          if (pose.world_landmarks[idx]) pose.world_landmarks[idx][0] += dx;
        }
        f.pose = pose;
      }
    }
  }

  /* ── zero-phase trajectory smoothing ────────────────────────────────
     The arm shake is the source data: MediaPipe's world landmarks jitter
     about 3mm per frame once mapped onto the avatar, and the rig follows
     it faithfully. A real-time EMA can only trail the signal — it halves
     the jitter but adds lag, and cranking it up to kill the shake would
     visibly soften the sign.

     But playback is composed in full before it ever runs, so we can filter
     it OFFLINE with a symmetric (centred) kernel. That removes far more
     noise for zero phase lag: a binomial [1,4,6,4,1] window here cuts the
     high-frequency component hard while leaving the stroke shape intact.

     Frames carry objects straight out of the recording cache, so everything
     touched is deep-copied first — filtering in place would corrupt the
     cache for every later sentence that reuses the same clip. */
  const SMOOTH_W = [1, 4, 6, 4, 1];
  const SMOOTH_R = (SMOOTH_W.length - 1) / 2;

  function smoothPointSeries(get, set, n) {
    const out = new Array(n);
    for (let i = 0; i < n; i++) {
      const base = get(i);
      if (!base) { out[i] = null; continue; }
      const acc = new Array(base.length);
      for (let k = 0; k < base.length; k++) acc[k] = [0, 0, 0];
      let wsum = 0;
      for (let d = -SMOOTH_R; d <= SMOOTH_R; d++) {
        const j = i + d;
        if (j < 0 || j >= n) continue;
        const p = get(j);
        if (!p || p.length !== base.length) continue;
        const w = SMOOTH_W[d + SMOOTH_R];
        wsum += w;
        for (let k = 0; k < p.length; k++) {
          acc[k][0] += p[k][0] * w;
          acc[k][1] += p[k][1] * w;
          acc[k][2] += p[k][2] * w;
        }
      }
      out[i] = wsum > 0
        ? acc.map(v => [v[0] / wsum, v[1] / wsum, v[2] / wsum])
        : base.map(p => [...p]);
    }
    for (let i = 0; i < n; i++) if (out[i]) set(i, out[i]);
  }

  function smoothFrames(frames) {
    const n = frames.length;
    if (n < 3) return;

    // detach from the recording cache before touching anything
    for (const f of frames) {
      if (f.pose) f.pose = { ...f.pose };
      if (f.hands) f.hands = f.hands.map(h => ({ ...h }));
    }

    // pose: drives the arms, so this is what kills the arm shake
    for (const key of ["world_landmarks", "landmarks"]) {
      smoothPointSeries(
        i => (frames[i].pose ? frames[i].pose[key] : null),
        (i, v) => { frames[i].pose[key] = v; },
        n,
      );
    }

    // hands: same treatment per side, which settles the finger jitter
    for (const side of ["Left", "Right"]) {
      const handAt = i => (frames[i].hands || []).find(h => h.handedness === side) || null;
      for (const key of ["world_landmarks", "landmarks"]) {
        smoothPointSeries(
          i => { const h = handAt(i); return h ? h[key] : null; },
          (i, v) => { const h = handAt(i); if (h) h[key] = v; },
          n,
        );
      }
    }
  }

  /* ── rest posture at the ends of a sentence ──────────────────────────
     trimRestPosture strips the hands-at-sides lead-in and lead-out from every
     dictionary clip, which is right BETWEEN signs — otherwise the avatar drops
     its arms after every word. But a sentence should still start and finish at
     rest, the way a signer does.

     So the posture is put back exactly twice, around the whole sequence. A
     real recorded frame is preferred: twtsl and moe clips carry a genuine one
     (measured wrist height -1.06 to -1.14, versus the -0.65 threshold), and
     that is 10,251 of the 12,517 lexicon entries. moc clips are cut from
     continuous signing and never reach rest — measured, 0 of 10 had a lead-in
     — and a sentence can be entirely moc (我想去日本玩 is), so there is a
     constructed fallback for that case. */
  const REST_DEEP = -0.9;      // unambiguously hands-at-sides
  const REST_HOLD_SEC = 0.30;
  const REST_BLEND_SEC = 0.45;

  /* the deepest rest frame in the lead-in (or lead-out) of a raw clip */
  function findRestFrame(raw, fromStart) {
    let best = null, bestH = REST_DEEP;
    const idx = fromStart ? [...raw.keys()] : [...raw.keys()].reverse();
    for (const i of idx) {
      const h = wristHeight(raw[i]);
      if (h === null) continue;
      if (h > REST_ENTER) break;          // reached the sign itself
      if (h <= bestH) { bestH = h; best = raw[i]; }
    }
    return best;
  }

  /* Build a rest frame from a signing frame by lowering the arms in that
     frame's OWN body frame, so the signer's proportions carry over. Both the
     image landmarks (which wristHeight reads) and the world landmarks (which
     the retarget reads) have to agree, or the two disagree about where the
     arms are. */
  function synthRestFrame(src) {
    const p = src.pose;
    if (!p || !p.landmarks || !p.world_landmarks) return null;
    const lm = p.landmarks.map(v => [...v]);
    const wl = p.world_landmarks.map(v => [...v]);
    const shoY = (lm[L_SHO][1] + lm[R_SHO][1]) / 2;
    const hipY = (lm[L_HIP][1] + lm[R_HIP][1]) / 2;
    const torso = hipY - shoY;
    if (!(Math.abs(torso) > 1e-4)) return null;
    const halfW = Math.abs(lm[L_SHO][0] - lm[R_SHO][0]) / 2 || 0.1;
    for (const [sho, elb, wri, out] of [[L_SHO, 13, L_WRI, 1], [R_SHO, 14, R_WRI, -1]]) {
      lm[elb] = [lm[sho][0] + out * 0.10 * halfW, shoY + 0.60 * torso, lm[sho][2]];
      lm[wri] = [lm[sho][0] + out * 0.22 * halfW, shoY + 1.12 * torso, lm[sho][2]];
    }
    const mid = (a, b) => [0, 1, 2].map(i => (a[i] + b[i]) / 2);
    const sub = (a, b) => [0, 1, 2].map(i => a[i] - b[i]);
    const len = v => Math.hypot(v[0], v[1], v[2]) || 1e-6;
    const sMid = mid(wl[L_SHO], wl[R_SHO]);
    const hMid = mid(wl[L_HIP], wl[R_HIP]);
    const dv = sub(hMid, sMid);
    const torsoW = len(dv);
    const down = dv.map(v => v / torsoW);
    const rv = sub(wl[R_SHO], wl[L_SHO]);
    const width = len(rv);
    const right = rv.map(v => v / width);
    for (const [sho, elb, wri, out] of [[L_SHO, 13, L_WRI, -1], [R_SHO, 14, R_WRI, 1]]) {
      wl[elb] = [0, 1, 2].map(i =>
        wl[sho][i] + down[i] * 0.60 * torsoW + right[i] * out * 0.05 * width);
      wl[wri] = [0, 1, 2].map(i =>
        wl[sho][i] + down[i] * 1.12 * torsoW + right[i] * out * 0.11 * width);
    }
    const visibility = p.visibility ? [...p.visibility] : null;
    if (visibility) for (const i of [L_SHO, R_SHO, 13, 14, L_WRI, R_WRI, L_HIP, R_HIP]) visibility[i] = 1;
    // no hands: the retarget eases the fingers back to a neutral shape rather
    // than holding the last sign's handshape while the arms come down
    return { pose: { landmarks: lm, world_landmarks: wl, visibility }, hands: [], face: null };
  }

  /* hold at rest, ease into the sentence, ease out, hold at rest again */
  function addRestBookends(frames, openRaw, closeRaw) {
    if (!frames.length) return frames;
    // Hands are dropped from the rest frame even when it came from a real
    // recording. A recorded resting hand still carries the signer's own idle
    // curl, and driving the fingers from it leaves them visibly bent at the
    // ends of every sentence; with no hand data the retarget eases them back
    // to the model's own neutral instead.
    const bare = f => (f ? { ...f, hands: [] } : null);
    const open = bare((openRaw && findRestFrame(openRaw, true)) || synthRestFrame(frames[0]));
    const close = bare((closeRaw && findRestFrame(closeRaw, false))
      || synthRestFrame(frames[frames.length - 1]));
    const hold = Math.round(REST_HOLD_SEC * COMPOSE_FPS);
    const blend = Math.round(REST_BLEND_SEC * COMPOSE_FPS);
    const first = frames[0], last = frames[frames.length - 1];
    const out = [];
    // _tok is left null so the non-manual markers, which key off it, never
    // land on a bookend
    // _rest is a WEIGHT, not a flag: the retarget blends its own solution
    // toward a placed, straight-armed rest pose by this much. Ramping it
    // across the same frames as the cross-fade is what stops the arm snapping
    // between "retargeted" and "placed" at the seam.
    const pad = (a, b, k, body, rest) =>
      ({ ...blendFrame(a, b, k), _tok: null, _body: body, _rest: rest });
    if (open) {
      for (let i = 0; i < hold; i++) out.push(pad(open, open, 0, first._body, 1));
      for (let i = 1; i <= blend; i++)
        out.push(pad(open, first, i / (blend + 1), first._body, 1 - i / (blend + 1)));
    }
    out.push(...frames);
    if (close) {
      for (let i = 1; i <= blend; i++)
        out.push(pad(last, close, i / (blend + 1), last._body, i / (blend + 1)));
      for (let i = 0; i < hold; i++) out.push(pad(close, close, 0, last._body, 1));
    }
    let t = 0;
    return out.map((f, i) => {
      const frame = { ...f, index: i, timestamp: t };
      t += 1 / COMPOSE_FPS;
      return frame;
    });
  }

  /* every clip a token list needs, in playback order (deduped downstream) */
  function clipRequests(tokens, lexicon) {
    return tokens
      .flatMap(name => resolve(name, lexicon))
      .map(name => lexicon[name])
      .filter(entry => entry && entry.recording)
      .map(entry => ({ name: entry.recording, start: entry.start, end: entry.end }));
  }

  /* tokens (+ NMM tags) → a composed recording object, ready for playback */
  async function build(tokens, lexicon, tags = null, onProgress = null) {
    const frames = [];
    let t = 0;
    let src = null;
    let prevLast = null;
    let prevBody = null;
    // 一個 token 可能展開成多個動作(數字逐位、外語指拼),先攤平再跑
    const signs = tokens.flatMap(name => resolve(name, lexicon));
    // 整句的片段一次要齊：拿不到就不動，不要打到一半才發現缺詞
    await fetchSegments(clipRequests(tokens, lexicon), onProgress);

    let openRaw = null, closeRaw = null;
    for (const name of signs) {
      const entry = lexicon[name];
      if (!entry) continue;
      const clip = await fetchSegment(entry.recording, entry.start, entry.end);
      if (!clip) continue;
      if (!src) src = clip;
      // kept untrimmed: the rest posture lives in exactly the part the trims remove
      const raw = clip.frames;
      if (!openRaw) openRaw = raw;
      closeRaw = raw;
      // rest posture first (removes the arms-at-sides head/tail of dictionary
      // clips), then the speed pass for any static hold left at the edges
      const trimmed = trimNeutral(trimRestPosture(raw));
      if (!trimmed.length) continue;
      // body scale is spatial, so measure it before resampling changes the
      // frame count; the signer's build does not depend on playback speed
      const body = bodyScale(trimmed);
      const seg = normalizeTempo(trimmed);
      if (!seg.length) continue;

      if (prevLast) {  // cross-fade into this sign, longer when hands travel farther
        const n = Math.round(blendSeconds(prevLast, seg[0]) * COMPOSE_FPS);
        for (let i = 1; i <= n; i++) {
          const k = i / (n + 1);
          const bf = blendFrame(prevLast, seg[0], k);
          // ease the body scale across the seam too, so a change of signer
          // does not snap the arm mapping mid-transition
          const b = prevBody && body
            ? { width: prevBody.width + (body.width - prevBody.width) * k,
                torso: prevBody.torso + (body.torso - prevBody.torso) * k }
            : (body || prevBody);
          frames.push({ index: frames.length, timestamp: t, _tok: name, _body: b, ...bf });
          t += 1 / COMPOSE_FPS;
        }
      }
      const t0 = seg[0].timestamp;
      for (const f of seg) {
        frames.push({ ...f, index: frames.length, timestamp: t + (f.timestamp - t0), _tok: name, _body: body });
      }
      t += seg[seg.length - 1].timestamp - t0 + 1 / COMPOSE_FPS;
      prevLast = seg[seg.length - 1];
      prevBody = body;
    }

    if (!frames.length) return null;
    // rest posture first, so its transitions are filtered along with everything
    // else; then filter before the non-manual markers go on, or the 3Hz
    // headshake applyNMM injects would be filtered away with the noise
    const composed = addRestBookends(frames, openRaw, closeRaw);
    smoothFrames(composed);
    applyNMM(composed, tags, tokens);
    return {
      version: src.version,
      label: tokens.join(" "),
      fps: COMPOSE_FPS,
      source_width: src.source_width,
      source_height: src.source_height,
      created_at: src.created_at,
      frames: composed,
    };
  }

  window.Composer = {
    COMPOSE_FPS,
    loadLexicon,
    translate,
    tokenize,
    stripMarkers,
    resolve,
    fetchRecordingByName,
    fetchSegment,
    fetchSegments,
    repairHandedness,
    clipRequests,
    sliceSegment,
    blendFrame,
    blendSeconds,
    applyNMM,
    build,
    trimNeutral,
    trimRestPosture,
    wristHeight,
    bodyScale,
    smoothFrames,
    meanSpeed,
    retime,
    normalizeTempo,
    findRestFrame,
    synthRestFrame,
    addRestBookends,
  };
})();
