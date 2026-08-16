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

  /* greedy longest-match segmentation against lexicon keys (spaces also split) */
  function tokenize(text, lexicon) {
    const tokens = [], unknown = [];
    for (const chunk of text.trim().split(/[\s,，。.!！?？]+/).filter(Boolean)) {
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
    const res = await fetch(`recordings/${encodeURIComponent(name)}`, { cache: "no-store" });
    if (!res.ok) throw new Error(`recording ${name} not found`);
    return (recordingCache[name] = await res.json());
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

    const out = seg.slice(s, e + 1);
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

  /* tokens (+ NMM tags) → a composed recording object, ready for playback */
  async function build(tokens, lexicon, tags = null) {
    const frames = [];
    let t = 0;
    let src = null;
    let prevLast = null;
    let prevBody = null;
    const recordingsByName = {};
    const recordingNames = [...new Set(tokens
      .map(name => lexicon[name]?.recording)
      .filter(Boolean))];
    await Promise.all(recordingNames.map(async name => {
      recordingsByName[name] = await fetchRecordingByName(name);
    }));

    for (const name of tokens) {
      const entry = lexicon[name];
      if (!entry) continue;
      const recording = recordingsByName[entry.recording] || await fetchRecordingByName(entry.recording);
      if (!src) src = recording;
      // rest posture first (removes the arms-at-sides head/tail of dictionary
      // clips), then the speed pass for any static hold left at the edges
      const seg = trimNeutral(trimRestPosture(sliceSegment(recording, entry.start, entry.end)));
      if (!seg.length) continue;
      const body = bodyScale(seg);

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
    // filter before the non-manual markers go on, or the 3Hz headshake
    // applyNMM injects would be filtered away with the noise
    smoothFrames(frames);
    applyNMM(frames, tags, tokens);
    return {
      version: src.version,
      label: tokens.join(" "),
      fps: COMPOSE_FPS,
      source_width: src.source_width,
      source_height: src.source_height,
      created_at: src.created_at,
      frames,
    };
  }

  window.Composer = {
    COMPOSE_FPS,
    loadLexicon,
    translate,
    tokenize,
    fetchRecordingByName,
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
  };
})();
