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

  /* ── 方向動詞 ───────────────────────────────────────────────────────
     語料庫把「動詞往誰打」標成一個 gloss:`相信我`、`幫你`、`看自己`。
     詞庫裡有 `相信` 也有 `我`,就是沒有 `相信我` 這個鍵 —— 2026-08-22 盤點
     有 14 個 gloss、36 次出現卡在這裡。台灣手語的方向動詞是把動作的去向
     改成對方,虛擬人目前做不到改向,退而求其次打「詞根 + 人稱」:語意完整、
     語序也是合法的手語語序,只是少了那個方向變化。
     只認「結尾是人稱代名詞、去掉代名詞後剩下的整段是詞庫鍵」這一種形狀;
     代名詞表寫死,長的先比(`你們` 不能被 `們` 前面的 `你` 截走)。
     妳/她/它 詞庫未必有,折到 你/他。 */
  const PRONOUNS = ["你們", "我們", "他們", "自己", "我", "你", "妳", "他", "她", "它"];
  const PRONOUN_FOLD = { "妳": "你", "她": "他", "它": "他" };
  function directional(word, lexicon) {
    for (const p of PRONOUNS) {
      if (word.length <= p.length || !word.endsWith(p)) continue;
      const root = word.slice(0, -p.length);
      const pron = lexicon[p] ? p : PRONOUN_FOLD[p];
      if (lexicon[root] && pron && lexicon[pron]) return [root, pron];
    }
    return null;
  }

  /* ── 乾淨複合 ──────────────────────────────────────────────────────
     `三個小時`、`兩者距離`、`我們三個`:整串不是詞庫鍵,但從頭到尾可以切成
     幾個**都至少兩個字**的既有詞條,中間沒有破洞。這種切法多半是對的
     (2026-08-22 盤點歸為「乾淨複合(多半打得對)」),所以當最後一道退路。
     單字塊不收:`仔細看` 切成 `仔細`+`看` 看起來對,`張老師` 切成 `張`+`老師`
     就打成姓氏手語,`之於` 更是兩個不相干的字 —— 這些要人看過才能進
     COMPOUND 表。最長優先切,切不乾淨就整個不打,跟指拼同一個原則。 */
  function cleanCompound(word, lexicon) {
    const pieces = [];
    let i = 0;
    while (i < word.length) {
      let hit = null;
      for (let len = word.length - i; len >= 2; len--) {
        const cand = word.slice(i, i + len);
        if (lexicon[cand]) { hit = cand; break; }
      }
      if (!hit) return [];
      pieces.push(hit);
      i += hit.length;
    }
    return pieces.length >= 2 ? pieces : [];
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
    // 到這裡都沒中才輪到規則退路;順序固定:方向動詞先(`看自己` 是
    // 看+自己,不能被複合切成別的),再試乾淨複合
    const dir = directional(bare, lexicon);
    if (dir) return dir;
    return cleanCompound(bare, lexicon);
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

  /* ── the hand that is not signing goes down to the side ───────────────
     One-handed signs are written for the dominant hand alone (HamNoSys /
     SiGML specify only that hand), and the other one simply hangs. The
     recordings do not say "hanging", though. A standing signer's idle hand is
     below the frame, and MediaPipe still reports a wrist for it, INSIDE the
     frame, with visibility around 0.6 — above the retarget's 0.4 threshold.
     Measured on 我 (gs0914): that wrist's frame-to-frame noise is 0.15
     shoulder widths vertically and 0.22 in depth, eight times the pointing
     hand's, and the avatar followed it — the left arm floated up and down.
     Seated and dictionary signers rest the hand at the waist instead, where
     it is detected but does nothing (一點, 看, 口, 痛 — checked frame by frame).

     So each segment decides, per side, whether that hand signs at all, and a
     hand that does not is placed at rest for the whole sign: its hand
     landmarks are dropped and its elbow and wrist are replaced by a hanging
     arm built in the frame's own body frame (the same construction as the
     sentence's rest bookends), and the frames carry _restL/_restR so the
     retarget places that arm the way it places both arms at a sentence end.

     Two regimes, measured over 763 lexicon entries (1,526 hands):
     - detected (in ≥20% of frames): idle when 90% of the time the wrist never
       enters signing space (REST_ENTER, the threshold trimRestPosture already
       uses) and it travels less than 0.35 shoulder widths. A still hand held
       UP — 名字, 人, the fist of 對不起 — is in signing space and stays.
     - not detected: idle when its median height is below mid-torso and the
       other hand is clearly signing. The pose model's guess for an unseen
       wrist is biased upward and noisy (謝謝's left wrist: median -0.61, 90th
       percentile -0.51), so the bar is lower; requiring the other hand keeps
       low-resolution clips where no hand is detected at all out of it.
     Never both hands: the one entry where both qualified (家電行) is left
     alone.

     A sign can also use one hand for only PART of its length — 早安 is 早
     (one fist) and then 安 (both hands), and during 早 the left hand hangs out
     of view exactly like 我's. So within a sign whose hand does take part, a
     stretch of at least IDLE_RUN_SEC where that hand is not detected, its
     wrist sits below signing space and the other hand is signing is rested
     too, easing in and out over IDLE_RAMP_SEC of the neighbouring frames. */
  const IDLE_SEEN_DET = 0.2;
  const IDLE_STILL_RANGE = 0.35;   // shoulder widths
  const IDLE_UNSEEN_MEDIAN = -0.5;
  const IDLE_UNSEEN_P90 = -0.35;
  const IDLE_OTHER_DET = 0.5;
  const IDLE_RUN_SEC = 0.25;
  const IDLE_RAMP_SEC = 0.15;

  function quantile(v, q) {
    if (!v.length) return null;
    const a = [...v].sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(q * a.length))];
  }

  function idleSides(seg) {
    const idle = { Left: false, Right: false, weights: { Left: null, Right: null } };
    if (seg.length < 5) return idle;
    const widths = [];
    for (const f of seg) {
      const p = f.pose && f.pose.landmarks;
      if (p && p[L_SHO] && p[R_SHO]) widths.push(Math.hypot(p[L_SHO][0] - p[R_SHO][0], p[L_SHO][1] - p[R_SHO][1]));
    }
    const sw = median(widths);
    const stat = {};
    for (const [side, wi] of [["Left", L_WRI], ["Right", R_WRI]]) {
      let det = 0;
      const hs = [], xs = [], ys = [];
      for (const f of seg) {
        if ((f.hands || []).some(h => h.handedness === side)) det++;
        const p = f.pose && f.pose.landmarks;
        if (!p || !p[wi] || !p[L_HIP] || !p[R_HIP]) continue;
        const shoY = (p[L_SHO][1] + p[R_SHO][1]) / 2;
        const torso = (p[L_HIP][1] + p[R_HIP][1]) / 2 - shoY;
        if (torso > 1e-4) hs.push((shoY - p[wi][1]) / torso);
        xs.push(p[wi][0]);
        ys.push(p[wi][1]);
      }
      // range after a 5-frame running median, so single-frame spikes do not count
      const med5 = a => a.map((_, i) => median(a.slice(Math.max(0, i - 2), i + 3)));
      const xm = med5(xs), ym = med5(ys);
      const range = sw > 1e-4 && xm.length
        ? Math.hypot(quantile(xm, 0.95) - quantile(xm, 0.05), quantile(ym, 0.95) - quantile(ym, 0.05)) / sw
        : Infinity;
      stat[side] = { det: det / seg.length, hMed: median(hs), hP90: quantile(hs, 0.9), range };
    }
    for (const [side, other] of [["Left", "Right"], ["Right", "Left"]]) {
      const s = stat[side], o = stat[other];
      if (s.hMed === null) continue;
      idle[side] = s.det >= IDLE_SEEN_DET
        ? s.hP90 < REST_ENTER && s.range < IDLE_STILL_RANGE
        : s.hMed < IDLE_UNSEEN_MEDIAN && s.hP90 < IDLE_UNSEEN_P90 && o.det >= IDLE_OTHER_DET;
    }
    if (idle.Left && idle.Right) idle.Left = idle.Right = false;
    for (const side of ["Left", "Right"]) {
      if (!idle.Left && !idle.Right) idle.weights[side] = partialRest(seg, side);
    }
    if (idle.weights.Left && idle.weights.Right) idle.weights.Left = idle.weights.Right = null;
    return idle;
  }

  /* per-frame rest weights for the stretches of a sign one hand sits out, or
     null when there are none */
  function partialRest(seg, side) {
    const other = side === "Left" ? "Right" : "Left";
    const wi = side === "Left" ? L_WRI : R_WRI;
    const n = seg.length;
    const has = (i, s) => (seg[i].hands || []).some(h => h.handedness === s);
    const near = (i, s) => { for (let j = Math.max(0, i - 2); j <= Math.min(n - 1, i + 2); j++) if (has(j, s)) return true; return false; };
    const h = seg.map(f => {
      const p = f.pose && f.pose.landmarks;
      if (!p || !p[wi] || !p[L_HIP] || !p[R_HIP]) return null;
      const shoY = (p[L_SHO][1] + p[R_SHO][1]) / 2;
      const torso = (p[L_HIP][1] + p[R_HIP][1]) / 2 - shoY;
      return torso > 1e-4 ? (shoY - p[wi][1]) / torso : null;
    });
    const out = seg.map((_, i) => {
      if (near(i, side) || !near(i, other)) return false;
      const win = h.slice(Math.max(0, i - 2), i + 3).filter(v => v !== null);
      return win.length > 0 && median(win) < REST_ENTER;
    });
    const w = new Array(n).fill(0);
    let any = false;
    for (let i = 0; i < n;) {
      if (!out[i]) { i++; continue; }
      let j = i;
      while (j + 1 < n && out[j + 1]) j++;
      if (seg[j].timestamp - seg[i].timestamp >= IDLE_RUN_SEC) {
        any = true;
        for (let k = 0; k < n; k++) {
          const d = k < i ? seg[i].timestamp - seg[k].timestamp
            : k > j ? seg[k].timestamp - seg[j].timestamp : 0;
          w[k] = Math.max(w[k], Math.max(0, 1 - d / IDLE_RAMP_SEC));
        }
      }
      i = j + 1;
    }
    return any ? w : null;
  }

  /* copies of the segment's frames with the idle arms lowered and their hands
     dropped; _restL/_restR say how much of each arm the retarget should place */
  function restWeight(idle, side, i) {
    if (idle[side]) return 1;
    const w = idle.weights && idle.weights[side];
    return w ? w[i] : 0;
  }

  function lowerIdleArms(seg, idle) {
    return seg.map((f, i) => {
      const wL = restWeight(idle, "Left", i), wR = restWeight(idle, "Right", i);
      const out = { ...f, _restL: wL, _restR: wR };
      if (!(wL > 0) && !(wR > 0)) return out;
      out.hands = (f.hands || []).filter(h => restWeight(idle, h.handedness, i) < 0.5);
      if (f.pose) {
        const low = lowerArms(f.pose, wL > 0, wR > 0);
        if (low) {
          // partial weights blend the recorded arm toward the hanging one
          for (const [w, idx] of [[wL, [13, L_WRI]], [wR, [14, R_WRI]]]) {
            if (!(w > 0) || w >= 1) continue;
            for (const key of ["landmarks", "world_landmarks"]) {
              for (const j of idx) {
                const a = f.pose[key][j], b = low[key][j];
                low[key][j] = [0, 1, 2].map(c => a[c] + (b[c] - a[c]) * w);
              }
            }
            if (low.visibility && f.pose.visibility) for (const j of idx) {
              low.visibility[j] = w >= 0.5 ? 1 : f.pose.visibility[j];
            }
          }
          out.pose = low;
        }
      }
      return out;
    });
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

     Each segment is resampled so its stroke speed lands on TEMPO_TARGET.
     Resampling also puts every segment on COMPOSE_FPS; source clips run at
     their own rate (玩 was recorded at ~60fps).

     ── 2026-09-15: every sign now plays at the SAME speed ────────────────
     The first version still let the speed vary by 2x, measured over 763
     lexicon entries, for three reasons:

     1. It was measured in normalised IMAGE units, but the avatar reproduces
        motion relative to the signer's BODY (solveArm divides by shoulder
        width). A signer standing close to the camera (shoulders 0.33 of the
        frame, tslsigner) and one far away (0.16, slwords) at the same image
        speed come out at 1.2 and 2.5 shoulder-widths per second on the
        avatar. Speed is now shoulder widths per second — the scale the sign
        language literature normalises poses by (biacromial width) — measured
        on the world landmarks' image plane, which is metric on both axes
        (normalised x and y are fractions of different lengths).
     2. Landmark noise was counted as travel. Path length grows with jitter,
        and grows again with frame rate, so a noisy or 60fps clip read as
        "fast" and got slowed down. The wrist is now resampled to COMPOSE_FPS
        and passed through the playback smoothing kernel before its path is
        summed, and a hand that is not signing (see idleSides) is not counted
        at all — on 我 the hanging left wrist's noise had more "path" than the
        pointing hand.
     3. The scale was clamped to 0.3–2.5x and the duration to 0.35–2.6s, and
        241 of 763 entries hit a clamp. Only the lower duration bound is kept:
        a sign with almost no movement has no speed to equalise, and the floor
        is what keeps 家 readable. Everything else lands on the target. */
  /* 1.1 is where the new measure puts the typical sign: over 688 entries the
     sum of all sign durations comes out at 0.98 of what it was, so sentences
     keep their overall length and only the unevenness goes (spread of output
     speed, CV, 0.48 → 0.10; all of what is left is the 44 signs held up by the
     floor below). Measured on the avatar's own hands the CV is about 0.25:
     the retarget maps sideways and up/forward travel at different scales and
     its stroke amplifier is off during holds, so very short signs and long
     holds still read a little faster or slower. No upper bound: the long
     outliers are genuinely long — 小烏來風景特定區 is five signs, and 2.6s
     played them at five times the speed of everything around them. */
  const TEMPO_TARGET = 1.1;    // shoulder widths of wrist path per second
  const TEMPO_MIN_SEC = 0.35;  // a sign with (almost) no movement still needs to be readable

  /* the wrist's travel in shoulder widths — resampled onto COMPOSE_FPS and
     smoothed first, so neither jitter nor frame rate adds distance */
  function wristTravel(seg, wi) {
    const t0 = seg[0].timestamp;
    const dur = seg[seg.length - 1].timestamp - t0;
    const n = Math.max(2, Math.round(dur * COMPOSE_FPS) + 1);
    const pts = [];
    let j = 0;
    for (let i = 0; i < n; i++) {
      const st = t0 + (dur * i) / (n - 1);
      while (j < seg.length - 2 && seg[j + 1].timestamp < st) j++;
      const a = seg[j], b = seg[j + 1] || seg[j];
      const wa = a.pose && a.pose.world_landmarks && a.pose.world_landmarks[wi];
      const wb = b.pose && b.pose.world_landmarks && b.pose.world_landmarks[wi];
      if (!wa || !wb) { pts.push(null); continue; }
      const k = Math.min(1, Math.max(0, (st - a.timestamp) / Math.max(1e-6, b.timestamp - a.timestamp)));
      pts.push([wa[0] + (wb[0] - wa[0]) * k, wa[1] + (wb[1] - wa[1]) * k]);
    }
    let path = 0, prev = null;
    for (let i = 0; i < n; i++) {
      if (!pts[i]) { prev = null; continue; }
      let x = 0, y = 0, wsum = 0;
      for (let d = -SMOOTH_R; d <= SMOOTH_R; d++) {
        const p = pts[i + d];
        if (!p) continue;
        const w = SMOOTH_W[d + SMOOTH_R];
        x += p[0] * w; y += p[1] * w; wsum += w;
      }
      const cur = [x / wsum, y / wsum];
      if (prev) path += Math.hypot(cur[0] - prev[0], cur[1] - prev[1]);
      prev = cur;
    }
    return path;
  }

  /* shoulder width on the world landmarks' image plane (metres) */
  function shoulderWidthXY(seg) {
    const widths = [];
    for (const f of seg) {
      const w = f.pose && f.pose.world_landmarks;
      if (w && w[L_SHO] && w[R_SHO]) widths.push(Math.hypot(w[L_SHO][0] - w[R_SHO][0], w[L_SHO][1] - w[R_SHO][1]));
    }
    return median(widths);
  }

  /* shoulder widths per second of the busier signing hand */
  function strokeSpeed(seg, idle = {}) {
    if (seg.length < 3) return null;
    const dur = seg[seg.length - 1].timestamp - seg[0].timestamp;
    const width = shoulderWidthXY(seg);
    if (!(dur > 1e-3) || !(width > 1e-3)) return null;
    let path = 0;
    for (const [side, wi] of [["Left", L_WRI], ["Right", R_WRI]]) {
      if (!idle[side]) path = Math.max(path, wristTravel(seg, wi));
    }
    return path / width / dur;
  }

  /* Total wrist path divided by duration (the first version's measure, in
     image units; kept for the audit tools that still read it).
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
    // Skipping a near-1 scale is only safe when the clip is already on
    // COMPOSE_FPS: a 60fps clip passed through untouched kept twice the frames,
    // so smoothFrames' 5-frame kernel spanned half the time on that sign alone.
    const step = seg.length > 1 ? (seg[seg.length - 1].timestamp - seg[0].timestamp) / (seg.length - 1) : 0;
    const onGrid = Math.abs(step * COMPOSE_FPS - 1) < 0.1;
    if (seg.length < 3 || (Math.abs(scale - 1) < 0.03 && onGrid)) return seg;
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
      out.push(mix(a, b, k, t0 + u * outDur));
    }
    return out;
  }

  /* Speed alone is not enough to decide a duration. 家 covers very little
     ground in 0.35s, so matching its speed to the target would compress it to
     0.13s — four frames, unreadable. The lower duration bound is what stops a
     sign with little movement from vanishing; it is the only bound left. */
  function normalizeTempo(seg, idle = {}) {
    const speed = strokeSpeed(seg, idle);
    if (!speed || seg.length < 3) return seg;
    const dur = seg[seg.length - 1].timestamp - seg[0].timestamp;
    const scale = Math.max(speed / TEMPO_TARGET, TEMPO_MIN_SEC / dur);
    return retime(seg, scale);
  }

  /* Transitions move at the same speed as the signs: the time between two
     signs is how far the wrists have to travel, in shoulder widths, divided
     by TEMPO_TARGET. It used to be 0.12 + 0.9 × the image-space distance
     capped at 0.55s — about twice the sign speed, so every sign was followed
     by a snap. Wrists, not hands: a hand dropping to rest (see idleSides) has
     no hand landmarks but still has to travel. */
  const TRAVEL_MIN_SEC = 0.12;
  const TRAVEL_MAX_SEC = 0.9;

  function travelSeconds(a, b, widthA, widthB) {
    const wa = a.pose && a.pose.world_landmarks, wb = b.pose && b.pose.world_landmarks;
    const width = ((widthA || 0) + (widthB || 0)) / ((widthA ? 1 : 0) + (widthB ? 1 : 0) || 1);
    if (!wa || !wb || !(width > 1e-3)) return blendSeconds(a, b);
    let d = 0;
    for (const wi of [L_WRI, R_WRI]) {
      if (wa[wi] && wb[wi]) d = Math.max(d, Math.hypot(wb[wi][0] - wa[wi][0], wb[wi][1] - wa[wi][1]));
    }
    /* smootherstep 的最大斜率是平均的 1.875 倍。時間不必整個乘回去——詞與詞之間的移動
       （epenthesis）本來就可以比手語本身快一些；乘 1.3 讓尖峰約為手語速度的 1.4 倍，
       整句長度才不會被接縫吃掉（實測 4 個詞的句子，1.875 要多花 0.6 秒）。 */
    return Math.min(TRAVEL_MAX_SEC, Math.max(TRAVEL_MIN_SEC, 1.3 * d / width / TEMPO_TARGET));
  }

  /* ── the seam between two signs ──────────────────────────────────────
     Two things made the join read as a stop-and-go rather than one flowing
     utterance. Measured on 我 喝 水 (avatar wrist speed, shoulder widths per
     second): 我 ended with 0.6s under 0.3, 喝 with 0.45s, and the travel
     between them was 0.2–0.3s at 3–4 — a long stall, then a jerk.

     1. The stall is the clip's own final hold. Continuous signing shortens
        exactly those: hold reduction is a named phonological process (a sign's
        hold is cut when another sign follows), so the tail and head holds are
        trimmed back to HOLD_KEEP, up to HOLD_CUT_MAX.
     2. The jerk is the cross-fade's linear parameter: velocity jumps from 0 to
        the travel speed at the seam and back. Cross-fading is known for
        exactly this (discontinuous joint velocities), and the game-animation
        answer — inertialization — replaces it with a curve that matches
        velocity at both ends. Offline we can simply ease the blend parameter
        with smootherstep, whose derivative is zero at both ends: the hands
        leave the last pose and arrive at the next one at zero speed, with no
        velocity step anywhere. */
  const HOLD_SPEED = 0.25;     // 肩寬/秒：低於此視為靜止
  const HOLD_KEEP = 0.10;      // 頭尾的靜止段壓到這麼長
  const HOLD_MAX = 0.25;       // 詞中間的定格上限（定格是手語的一部分，不能全吃掉）

  const smootherstep = x => (x <= 0 ? 0 : x >= 1 ? 1 : x * x * x * (x * (x * 6 - 15) + 10));

  /* 每幀的手腕速度（肩寬/秒），取兩手中較快的一隻 */
  function wristSpeeds(seg) {
    const width = shoulderWidthXY(seg);
    const out = new Array(seg.length).fill(0);
    if (!(width > 1e-3)) return out;
    for (let i = 1; i < seg.length; i++) {
      const a = seg[i - 1].pose && seg[i - 1].pose.world_landmarks;
      const b = seg[i].pose && seg[i].pose.world_landmarks;
      const dt = seg[i].timestamp - seg[i - 1].timestamp;
      if (!a || !b || !(dt > 1e-6)) continue;
      let m = 0;
      for (const wi of [L_WRI, R_WRI]) {
        if (a[wi] && b[wi]) m = Math.max(m, Math.hypot(b[wi][0] - a[wi][0], b[wi][1] - a[wi][1]));
      }
      out[i] = m / width / dt;
    }
    out[0] = out[1] || 0;
    return out;
  }

  /* hold reduction：把靜止段壓短。頭尾的壓到 HOLD_KEEP，詞中間的壓到 HOLD_MAX。
     只改時間、不動姿勢：把每一幀的時間間隔乘上係數，再重新取樣回 COMPOSE_FPS。
     （我 的定格在詞的中間 0.5 秒，光裁頭尾裁不到。） */
  function reduceHolds(seg) {
    if (seg.length < 8) return seg;
    const v = wristSpeeds(seg);
    const still = v.map(x => x < HOLD_SPEED);
    const scale = new Array(seg.length).fill(1);
    let i = 0, changed = false;
    while (i < seg.length) {
      if (!still[i]) { i++; continue; }
      let j = i;
      while (j + 1 < seg.length && still[j + 1]) j++;
      const dur = seg[j].timestamp - seg[i].timestamp;
      const cap = (i === 0 || j === seg.length - 1) ? HOLD_KEEP : HOLD_MAX;
      if (dur > cap + 1e-6) {
        const f = cap / dur;
        for (let k = i + 1; k <= j; k++) scale[k] = f;
        changed = true;
      }
      i = j + 1;
    }
    if (!changed) return seg;
    const tOut = [0];
    for (let k = 1; k < seg.length; k++) {
      tOut.push(tOut[k - 1] + (seg[k].timestamp - seg[k - 1].timestamp) * scale[k]);
    }
    const total = tOut[tOut.length - 1];
    if (!(total > 0.2)) return seg;
    const n = Math.max(2, Math.round(total * COMPOSE_FPS));
    const t0 = seg[0].timestamp;
    const out = [];
    let j = 0;
    for (let m = 0; m <= n; m++) {
      const tt = (total * m) / n;
      while (j < seg.length - 2 && tOut[j + 1] < tt) j++;
      const span = Math.max(1e-6, tOut[j + 1] - tOut[j]);
      const k = Math.min(1, Math.max(0, (tt - tOut[j]) / span));
      out.push(mix(seg[j], seg[j + 1], k, t0 + tt));
    }
    return out;
  }

  /* blendFrame 只回傳 pose/hands/face，自訂欄位要自己帶（每側的休息權重是隨時間變的） */
  function mix(a, b, k, timestamp) {
    const lerpW = key => (a[key] || 0) + ((b[key] || 0) - (a[key] || 0)) * k;
    return { ...blendFrame(a, b, k), timestamp, _restL: lerpW("_restL"), _restR: lerpW("_restR") };
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
  /* 收手/抬手的時間也照距離算（同 travelSeconds）。原本固定 0.45 秒，
     手離身側越遠收得越快——量到句尾收手尖峰 7.5 肩寬/秒，是手語動作的 4 倍。 */
  const REST_BLEND_MIN = 0.30;
  const REST_BLEND_MAX = 0.70;

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
    const pose = src.pose ? lowerArms(src.pose, true, true) : null;
    // no hands: the retarget eases the fingers back to a neutral shape rather
    // than holding the last sign's handshape while the arms come down
    return pose ? { pose, hands: [], face: null } : null;
  }

  /* the pose with either or both arms hanging (idleSides lowers just one) */
  function lowerArms(p, lowerLeft, lowerRight) {
    if (!p || !p.landmarks || !p.world_landmarks) return null;
    const lm = p.landmarks.map(v => [...v]);
    const wl = p.world_landmarks.map(v => [...v]);
    const shoY = (lm[L_SHO][1] + lm[R_SHO][1]) / 2;
    const hipY = (lm[L_HIP][1] + lm[R_HIP][1]) / 2;
    const torso = hipY - shoY;
    if (!(Math.abs(torso) > 1e-4)) return null;
    const halfW = Math.abs(lm[L_SHO][0] - lm[R_SHO][0]) / 2 || 0.1;
    const sides = [[L_SHO, 13, L_WRI, 1, lowerLeft], [R_SHO, 14, R_WRI, -1, lowerRight]];
    for (const [sho, elb, wri, out, lower] of sides) {
      if (!lower) continue;
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
    for (const [sho, elb, wri, out, lower] of sides) {
      if (!lower) continue;
      // the world frame's "right" runs the other way from the image's x
      wl[elb] = [0, 1, 2].map(i =>
        wl[sho][i] + down[i] * 0.60 * torsoW - right[i] * out * 0.05 * width);
      wl[wri] = [0, 1, 2].map(i =>
        wl[sho][i] + down[i] * 1.12 * torsoW - right[i] * out * 0.11 * width);
    }
    const visibility = p.visibility ? [...p.visibility] : null;
    if (visibility) {
      for (const i of [L_SHO, R_SHO, L_HIP, R_HIP]) visibility[i] = 1;
      if (lowerLeft) visibility[13] = visibility[L_WRI] = 1;
      if (lowerRight) visibility[14] = visibility[R_WRI] = 1;
    }
    return { landmarks: lm, world_landmarks: wl, visibility };
  }

  /* hold at rest, ease into the sentence, ease out, hold at rest again */
  function addRestBookends(frames, openRaw, closeRaw) {
    if (!frames.length) return frames;
    // Hands are dropped from the rest frame even when it came from a real
    // recording. A recorded resting hand still carries the signer's own idle
    // curl, and driving the fingers from it leaves them visibly bent at the
    // ends of every sentence; with no hand data the retarget eases them back
    // to the model's own neutral instead.
    // The arms are replaced too. The deepest recorded frame is the one where a
    // standing signer's hands have left the picture, and MediaPipe's wrists
    // there are guesses below the retarget's visibility threshold — which sent
    // the arms toward the model's T-pose through the whole opening hold. The
    // rest pose is placed rather than retargeted anyway, so constructed hanging
    // arms lose nothing and give the ramp into the first sign a clean start.
    const bare = f => (f ? { ...f, hands: [], pose: lowerArms(f.pose, true, true) || f.pose } : null);
    const open = bare((openRaw && findRestFrame(openRaw, true)) || synthRestFrame(frames[0]));
    const close = bare((closeRaw && findRestFrame(closeRaw, false))
      || synthRestFrame(frames[frames.length - 1]));
    const hold = Math.round(REST_HOLD_SEC * COMPOSE_FPS);
    const first = frames[0], last = frames[frames.length - 1];
    const rampFor = (a, b) => {
      const w = shoulderWidthXY([a, b]);
      const wa = a.pose && a.pose.world_landmarks, wb = b.pose && b.pose.world_landmarks;
      if (!wa || !wb || !(w > 1e-3)) return Math.round(0.45 * COMPOSE_FPS);
      let d = 0;
      for (const wi of [L_WRI, R_WRI]) {
        if (wa[wi] && wb[wi]) d = Math.max(d, Math.hypot(wb[wi][0] - wa[wi][0], wb[wi][1] - wa[wi][1]));
      }
      const sec = Math.min(REST_BLEND_MAX, Math.max(REST_BLEND_MIN, 1.3 * d / w / TEMPO_TARGET));
      return Math.round(sec * COMPOSE_FPS);
    };
    const out = [];
    // _tok is left null so the non-manual markers, which key off it, never
    // land on a bookend
    // _rest is a WEIGHT, not a flag: the retarget blends its own solution
    // toward a placed, straight-armed rest pose by this much. Ramping it
    // across the same frames as the cross-fade is what stops the arm snapping
    // between "retargeted" and "placed" at the seam.
    // _restL/_restR come from the sign next to the bookend, so a hand that sat
    // out the first or last sign stays down through the ramp instead of
    // rising with the other one
    /* 漸變段（抬手／收手）帶著相鄰手語的手部資料走。rest 幀沒有手，blendFrame
       因此整段都不給手，虛擬人只好在手語第一幀才拿到掌心方向——量到前臂在那一幀
       轉了 90 度（2710°/秒），看起來就是手腕翻過去。手的 landmark 只決定手形與掌心
       朝向（位置來自姿態），提早給等於在抬手途中就把手形做好，真人也是這樣。 */
    /* _ramp 標記「這一幀的手是從隔壁手語借來的」（抬手／收手漸變段，不是靜止段）。
       這種幀的手腕本來就低——是這裡自己合成的，不是打者把手放下去，所以重定向端
       不該用 wristLow 把它當成不可信的資料丟掉（見 avatar3d 的 LOW_HAND_ENTER）。 */
    const pad = (a, b, k, body, rest, side) =>
      ({ ...blendFrame(a, b, k), hands: side.hands || [], _tok: null, _body: body, _rest: rest,
         _ramp: side.hands && side.hands.length ? 1 : 0,
         _restL: side._restL || 0, _restR: side._restR || 0 });
    if (open) {
      const blend = rampFor(open, first);
      for (let i = 0; i < hold; i++) out.push(pad(open, open, 0, first._body, 1, open));
      for (let i = 1; i <= blend; i++) {
        const u = i / (blend + 1);
        out.push(pad(open, first, smootherstep(u), first._body, 1 - smootherstep(u), first));
      }
    }
    out.push(...frames);
    if (close) {
      const blend = rampFor(last, close);
      for (let i = 1; i <= blend; i++) {
        const u = i / (blend + 1);
        out.push(pad(last, close, smootherstep(u), last._body, smootherstep(u), last));
      }
      for (let i = 0; i < hold; i++) out.push(pad(close, close, 0, last._body, 1, close));
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
    let prevWidth = null;
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
      // a hand that sits this sign out goes down to the side (see idleSides)
      const idle = idleSides(trimmed);
      const lowered = lowerIdleArms(trimmed, idle);
      // body scale is spatial, so measure it before resampling changes the
      // frame count; the signer's build does not depend on playback speed
      const body = bodyScale(lowered);
      const width = shoulderWidthXY(lowered);
      // retime／reduceHolds 會重建幀，但兩者都用 mix() 把每側的休息權重一起內插
      const seg = reduceHolds(normalizeTempo(lowered, idle));
      if (!seg.length) continue;

      if (prevLast) {  // cross-fade into this sign, as long as the wrists take to travel there
        const n = Math.round(travelSeconds(prevLast, seg[0], prevWidth, width) * COMPOSE_FPS);
        for (let i = 1; i <= n; i++) {
          const k = smootherstep(i / (n + 1));   // 速度在兩端都是 0，接縫沒有速度跳階
          const bf = blendFrame(prevLast, seg[0], k);
          // ease the body scale across the seam too, so a change of signer
          // does not snap the arm mapping mid-transition
          const b = prevBody && body
            ? { width: prevBody.width + (body.width - prevBody.width) * k,
                torso: prevBody.torso + (body.torso - prevBody.torso) * k }
            : (body || prevBody);
          // and a hand going down to (or coming up from) rest ramps its weight
          // over the same frames its landmarks travel
          const restL = prevLast._restL + (seg[0]._restL - prevLast._restL) * k;
          const restR = prevLast._restR + (seg[0]._restR - prevLast._restR) * k;
          frames.push({ index: frames.length, timestamp: t, _tok: name, _body: b,
            _restL: restL, _restR: restR, _seam: true, ...bf });
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
      prevWidth = width;
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
    strokeSpeed,
    travelSeconds,
    idleSides,
    lowerIdleArms,
    reduceHolds,
    smootherstep,
    findRestFrame,
    synthRestFrame,
    addRestBookends,
  };
})();
