/* 3D rigged avatar: VRM model driven by SignAvatar recordings.
 *
 * Bone rotations are solved here directly from the recorded landmarks:
 * arms by two-bone IK from the pose, fingers and wrist by aiming each bone
 * along its measured joint-to-joint direction.
 * Face expressions map directly from the recorded ARKit blendshapes.
 * Exposed as window.Avatar3D; the classic viewer script drives it.
 */

import * as THREE from "three";
import { GLTFLoader } from "./vendor/GLTFLoader.js";
import { VRMLoaderPlugin, VRMUtils } from "./vendor/three-vrm.module.js";

let renderer = null;
let scene = null;
let cam = null;
let vrm = null;
let ready = false;

const TARGET = new THREE.Vector3(0, 1.05, 0); // orbit center; refit to the model on load
let baseDist = 2.2;                            // distance that frames the upper body
const BASE_2D_DIST = 1.4;                      // typical 2D-stage dist; wheel zoom maps through this
const SAFE_STAGE_ASPECT = 1.6;                 // pull back on narrow stages so extended hands stay visible
const HEAD_TARGET_BLEND = 0.58;                // reduce headroom while preserving room for head movement

function init(canvas) {
  renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
  renderer.setPixelRatio(window.devicePixelRatio || 1);
  scene = new THREE.Scene();
  cam = new THREE.PerspectiveCamera(30, 1, 0.1, 30);

  scene.add(new THREE.HemisphereLight(0xe8e4d9, 0x30343c, 1.4));
  const key = new THREE.DirectionalLight(0xfff2dd, 1.6);
  key.position.set(1.5, 2.5, 2.0);
  scene.add(key);

  const grid = new THREE.GridHelper(2.4, 16, 0x39404a, 0x232830);
  scene.add(grid);

  return loadModel("models/avatar.vrm");
}

function loadModel(url) {
  ready = false;
  const loader = new GLTFLoader();
  loader.register(parser => new VRMLoaderPlugin(parser));
  return new Promise((resolve, reject) => {
    loader.load(
      url,
      gltf => {
        if (vrm) {
          scene.remove(vrm.scene);
          VRMUtils.deepDispose(vrm.scene);
        }
        vrm = gltf.userData.vrm;
        VRMUtils.removeUnnecessaryVertices(gltf.scene);
        VRMUtils.combineSkeletons(gltf.scene);
        if (VRMUtils.rotateVRM0) VRMUtils.rotateVRM0(vrm); // vrm0 → face +Z
        scene.add(vrm.scene);
        vrm.scene.rotation.y = Math.PI; // face the default camera
        vrm.scene.updateMatrixWorld(true);

        // frame the upper body from the model's own proportions
        const head = new THREE.Vector3();
        const hips = new THREE.Vector3();
        vrm.humanoid.getNormalizedBoneNode("head").getWorldPosition(head);
        vrm.humanoid.getNormalizedBoneNode("hips").getWorldPosition(hips);
        TARGET.set(0, hips.y + (head.y - hips.y) * HEAD_TARGET_BLEND, 0);
        baseDist = Math.max(1.6, (head.y - hips.y) * 3.6);

        captureArmRest();
        captureFingerRest();
        fitBodyVolumes();   // needs BODY.width from captureArmRest
        resolveExpressions();
        resetSmoothing();  // BODY frame changed: stale smoothed targets are meaningless
        ready = true;
        resolve();
      },
      undefined,
      reject,
    );
  });
}

/* Axis-convention tuning between our recordings, kalidokit, and the VRM rig.
 * Mutable at runtime (window.Avatar3D.tune) for empirical calibration. */
/* Calibrated against the DGS reference clip (see session notes): kalidokit
 * wants MediaPipe-native (unmirrored) input and its rotations then apply to
 * the normalized VRM rig without sign flips. */
const TUNE = { unmirror: true, fx: 1, fy: 1, fz: 1, swapSides: false, hipsYaw: 0, sceneYaw: 0 };

const poseLm = (pts, vis, world) =>
  pts.map((p, j) => ({
    x: TUNE.unmirror ? (world ? -p[0] : 1 - p[0]) : p[0],
    y: p[1],
    z: p[2],
    visibility: vis ? vis[j] : 1,
  }));

const handLm = pts =>
  pts.map(p => ({ x: TUNE.unmirror ? 1 - p[0] : p[0], y: p[1], z: p[2], visibility: 1 }));

/* ── two-bone IK: anchor avatar wrists to the recorded wrist positions ──
 * Kalidokit's forward rotation chains drift positionally; sign language
 * needs the hands WHERE the signer put them. We solve shoulder+elbow
 * rotations analytically so the avatar wrist lands on the pose-landmark
 * wrist (scaled signer→avatar arm length), elbow steered by the recorded
 * elbow as a pole hint. */
const ARM = {};  // per side: nodes, rest dirs/quats, segment lengths

function captureArmRest() {
  for (const side of ["left", "right"]) {
    const upper = vrm.humanoid.getNormalizedBoneNode(`${side}UpperArm`);
    const lower = vrm.humanoid.getNormalizedBoneNode(`${side}LowerArm`);
    const hand = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`);
    const s = new THREE.Vector3(), e = new THREE.Vector3(), w = new THREE.Vector3();
    upper.getWorldPosition(s);
    lower.getWorldPosition(e);
    hand.getWorldPosition(w);
    ARM[side] = {
      upper, lower, hand,
      L1: s.distanceTo(e),
      L2: e.distanceTo(w),
      restDirUpper: e.clone().sub(s).normalize(),
      restDirLower: w.clone().sub(e).normalize(),
      restQUpper: upper.getWorldQuaternion(new THREE.Quaternion()),
      restQLower: lower.getWorldQuaternion(new THREE.Quaternion()),
    };

    // rest palm basis for exact wrist orientation (from the finger root bones)
    const mid = vrm.humanoid.getNormalizedBoneNode(`${side}MiddleProximal`);
    const idx = vrm.humanoid.getNormalizedBoneNode(`${side}IndexProximal`);
    const lit = vrm.humanoid.getNormalizedBoneNode(`${side}LittleProximal`);
    if (mid && idx && lit) {
      const m = mid.getWorldPosition(new THREE.Vector3());
      const i = idx.getWorldPosition(new THREE.Vector3());
      const l = lit.getWorldPosition(new THREE.Vector3());
      ARM[side].restQHand = hand.getWorldQuaternion(new THREE.Quaternion());
      ARM[side].restPalm = palmBasis(w, m, i, l);
    }
  }

  // avatar body frame: sign locations map body-relative (chin stays chin,
  // chest stays chest) instead of by metric arm-length scaling — anime
  // proportions would otherwise land face-level signs at the collar
  const sL = ARM.left.upper.getWorldPosition(new THREE.Vector3());
  const sR = ARM.right.upper.getWorldPosition(new THREE.Vector3());
  const hips = vrm.humanoid.getNormalizedBoneNode("hips").getWorldPosition(new THREE.Vector3());
  const sMid = sL.clone().add(sR).multiplyScalar(0.5);
  BODY.shoulder = { left: sL, right: sR };
  BODY.width = sL.distanceTo(sR);
  BODY.torso = sMid.distanceTo(hips);
  BODY.right = sR.clone().sub(sL).normalize();
  BODY.up = sMid.clone().sub(hips).normalize();
  BODY.fwd = new THREE.Vector3().crossVectors(BODY.right, BODY.up).normalize();
}

const BODY = {};

/* ── body collision volumes ──────────────────────────────────────────
 * The wrist target is mapped body-relative, which keeps a chin-height sign
 * at chin height — but nothing stopped it landing INSIDE the mesh. Anime
 * proportions make this routine: the head is far bigger relative to the
 * torso than a real signer's, so any sign near the face drives the hand
 * through it.
 *
 * We fit a torso capsule and a head sphere to the model's OWN vertices at
 * load time (radii from a high percentile, not the max, so stray hair or
 * skirt geometry doesn't inflate them), then push the wrist target back out
 * to the surface. Contact signs still reach the face — they rest on it
 * instead of sinking in. */
const VOL = { torso: null, head: null };
const TORSO_BANDS = 6;   // hips → neck, so the profile can taper

function fitBodyVolumes() {
  const hips = vrm.humanoid.getNormalizedBoneNode("hips").getWorldPosition(new THREE.Vector3());
  const neck = (vrm.humanoid.getNormalizedBoneNode("neck")
    || vrm.humanoid.getNormalizedBoneNode("head")).getWorldPosition(new THREE.Vector3());
  const halfW = BODY.width / 2;

  // Torso cross-section is an ELLIPSE, not a circle: a chest is much deeper
  // than it is wide. Fitting one radius made it 0.130 while the shoulder
  // joint sits only 0.082 from the spine, so the constraint shoved the
  // resting arm out sideways and the avatar stood with its arms splayed.
  const torsoX = Array.from({ length: TORSO_BANDS }, () => []);
  const torsoZ = Array.from({ length: TORSO_BANDS }, () => []);
  const headR = [], headPts = [];
  const axis = neck.clone().sub(hips);
  const axisLen = Math.max(axis.length(), 1e-4);
  const axisN = axis.clone().divideScalar(axisLen);
  const v = new THREE.Vector3();

  vrm.scene.updateMatrixWorld(true);
  vrm.scene.traverse(o => {
    const g = o.geometry;
    if (!g || !g.attributes || !g.attributes.position) return;
    // Hair sits well proud of the skull and would inflate the head sphere,
    // holding face-contact signs (父親 touches the cheek) off the face.
    // Fitting to skin only lets the hand reach the face; hair intersecting
    // is the far smaller artefact.
    if (/hair/i.test(o.name || "")) return;
    const p = g.attributes.position;
    const stride = Math.max(1, Math.floor(p.count / 3000));  // sampling is plenty
    for (let i = 0; i < p.count; i += stride) {
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(o.matrixWorld);
      if (v.y > neck.y) {                     // head region
        headPts.push(v.clone());
      } else if (v.y > hips.y) {              // torso region
        // skip the arms: they stick out sideways well past the shoulders
        if (Math.abs(v.x) > halfW * 1.25) continue;
        const t = v.clone().sub(hips);
        const along = t.dot(axisN);
        if (along < 0 || along > axisLen) continue;
        const radial = t.sub(axisN.clone().multiplyScalar(along));
        // bucket by height: a torso tapers, and a single radius for the whole
        // column reads a hand resting by the (wide) hip as "inside the chest"
        const band = Math.min(TORSO_BANDS - 1, Math.floor(along / axisLen * TORSO_BANDS));
        torsoX[band].push(Math.abs(radial.x));
        torsoZ[band].push(Math.abs(radial.z));
      }
    }
  });

  const pct = (arr, q) => {
    if (!arr.length) return null;
    const a = arr.slice().sort((x, y) => x - y);
    return a[Math.min(a.length - 1, Math.floor(a.length * q))];
  };

  const rxs = torsoX.map(v => pct(v, 0.9));
  const rzs = torsoZ.map(v => pct(v, 0.9));
  // fill any empty band from its neighbours so the profile stays continuous
  const fill = arr => {
    for (let i = 0; i < arr.length; i++) {
      if (arr[i]) continue;
      const prev = arr.slice(0, i).reverse().find(Boolean);
      const next = arr.slice(i + 1).find(Boolean);
      arr[i] = prev || next || null;
    }
    return arr;
  };
  fill(rxs); fill(rzs);
  if (rxs.every(Boolean) && rzs.every(Boolean)) {
    VOL.torso = { a: hips.clone(), b: neck.clone(), rxs, rzs };
  }

  if (headPts.length) {
    const c = new THREE.Vector3();
    for (const q of headPts) c.add(q);
    c.divideScalar(headPts.length);
    for (const q of headPts) headR.push(q.distanceTo(c));
    VOL.head = { c, r: pct(headR, 0.9) };
  }
}

/* push a point out of the fitted volumes; returns the corrected point */
const SKIN = 0.02;  // ~half a hand thickness, so the palm rests on the surface

const PUSH_STATS = { calls: 0, hits: 0, headHits: 0, torsoHits: 0, maxPush: 0, sumPush: 0,
                     minHeadRatio: Infinity, minTorsoRatio: Infinity };

function pushOutOfBody(p) {
  const out = p.clone();
  PUSH_STATS.calls++;
  const h = VOL.head;
  if (h) {
    const d = out.clone().sub(h.c);
    const len = d.length();
    const min = h.r + SKIN;
    PUSH_STATS.minHeadRatio = Math.min(PUSH_STATS.minHeadRatio, len / min);
    if (len < min && len > 1e-5) { out.copy(h.c).add(d.multiplyScalar(min / len)); PUSH_STATS.headHits++; }
    else if (len <= 1e-5) { out.copy(h.c).add(new THREE.Vector3(0, 0, min)); PUSH_STATS.headHits++; }
  }
  const t = VOL.torso;
  if (t) {
    const axis = t.b.clone().sub(t.a);
    const len2 = Math.max(axis.lengthSq(), 1e-8);
    let u = out.clone().sub(t.a).dot(axis) / len2;
    u = Math.min(Math.max(u, 0), 1);
    const onAxis = t.a.clone().add(axis.multiplyScalar(u));
    const radial = out.clone().sub(onAxis);
    // elliptical test against the tapered profile, interpolated at this height
    const g = u * (t.rxs.length - 1);
    const i0 = Math.min(t.rxs.length - 1, Math.floor(g));
    const i1 = Math.min(t.rxs.length - 1, i0 + 1);
    const k = g - i0;
    const rx = (t.rxs[i0] + (t.rxs[i1] - t.rxs[i0]) * k) + SKIN;
    const rz = (t.rzs[i0] + (t.rzs[i1] - t.rzs[i0]) * k) + SKIN;
    const nx = radial.x / rx, nz = radial.z / rz;
    const e = Math.hypot(nx, nz);
    PUSH_STATS.minTorsoRatio = Math.min(PUSH_STATS.minTorsoRatio, e);
    if (e < 1) {
      PUSH_STATS.torsoHits++;
      if (e > 1e-5) {
        // scale outward along the same bearing until it sits on the ellipse
        radial.x /= e;
        radial.z /= e;
        out.copy(onAxis).add(radial);
      } else {
        out.copy(onAxis).add(new THREE.Vector3(0, 0, rz));
      }
    }
  }
  const moved = out.distanceTo(p);
  if (moved > 1e-6) {
    PUSH_STATS.hits++;
    PUSH_STATS.sumPush += moved;
    PUSH_STATS.maxPush = Math.max(PUSH_STATS.maxPush, moved);
  }
  return out;
}

/* orthonormal RIGHT-HANDED palm basis: x = wrist→middle, y ⟂ palm plane,
 * z = x×y. (A left-handed basis would break setFromRotationMatrix.) */
function palmBasis(wrist, middle, index, little) {
  const f = middle.clone().sub(wrist).normalize();
  const across = index.clone().sub(little).normalize();
  const n = new THREE.Vector3().crossVectors(f, across).normalize();
  const a = new THREE.Vector3().crossVectors(f, n);
  return new THREE.Matrix4().makeBasis(f, n, a);
}

/* Stored (mirrored) MediaPipe world coords → avatar display space.
 * MediaPipe: x right, y down, z more NEGATIVE toward the camera.
 * Avatar:    x screen-right, y up, z toward the camera. */
const mpToAvatar = p => new THREE.Vector3(-p[0], -p[1], -p[2]);

function aimBoneWorld(bone, restDir, restQ, targetDir, lerp) {
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const delta = new THREE.Quaternion().setFromUnitVectors(restDir, targetDir);
  const local = parentQ.invert().multiply(delta.multiply(restQ));
  bone.quaternion.slerp(local, lerp);
  bone.updateWorldMatrix(true, true);  // children too: the elbow reads its new position
}

/* ── temporal smoothing ──────────────────────────────────────────────
 * Every smoothing constant here is a TIME CONSTANT, converted to a
 * per-frame blend factor against the real dt. The old code slerped by a
 * fixed per-frame amount, so the actual smoothing changed with the
 * display refresh rate (a 144Hz monitor smoothed ~5x harder than 30Hz)
 * and the arm lagged the target by a variable amount — part of what read
 * as drift. It also lets the 30fps recording interpolate smoothly onto a
 * faster display instead of stepping. */
const smoothAlpha = (dt, tau) => 1 - Math.exp(-Math.max(dt, 1e-4) / tau);
const TAU_TARGET = 0.055;  // IK wrist/elbow target position
const TAU_ARM = 0.040;     // upper/lower arm rotation
const TAU_CHEST = 0.220;   // torso: deliberately sluggish, it should not twitch

const SMOOTH = {};  // per side: smoothed target + pole, in avatar space

function resetSmoothing() {
  for (const k of Object.keys(SMOOTH)) delete SMOOTH[k];
  for (const k of Object.keys(CORR)) delete CORR[k];
  for (const k of Object.keys(POLE_CORR)) delete POLE_CORR[k];
  resetFace();
}

function smoothVec(key, v, dt, tau) {
  const prev = SMOOTH[key];
  if (!prev) {
    SMOOTH[key] = v.clone();
    return v;
  }
  prev.lerp(v, smoothAlpha(dt, tau));
  return prev.clone();
}

function solveArm(side, poseWorld, visOK, handPresent, body = null, dt = 0.016) {
  const arm = ARM[side];
  if (!arm) return;
  const lerp = smoothAlpha(dt, TAU_ARM);
  const [iSho, iElb, iWri] = side === "left" ? [11, 13, 15] : [12, 14, 16];
  // a detected hand vouches for the wrist even when pose visibility dips
  if (!visOK(iSho) || (!visOK(iWri) && !handPresent)) {
    // no reliable target: ease back toward rest. Drop the cached target too,
    // or the collision pass would keep re-aiming this arm at a stale pose and
    // fight the easing.
    arm.lastT = null;
    arm.upper.quaternion.slerp(new THREE.Quaternion(), smoothAlpha(dt, 0.2));
    arm.lower.quaternion.slerp(new THREE.Quaternion(), smoothAlpha(dt, 0.2));
    return;
  }
  const sho = mpToAvatar(poseWorld[iSho]);
  const elb = mpToAvatar(poseWorld[iElb]);
  const wri = mpToAvatar(poseWorld[iWri]);

  // signer body frame (in the same mapped space)
  const sgL = mpToAvatar(poseWorld[11]);
  const sgR = mpToAvatar(poseWorld[12]);
  const hgMid = mpToAvatar(poseWorld[23]).add(mpToAvatar(poseWorld[24])).multiplyScalar(0.5);
  const sgMid = sgL.clone().add(sgR).multiplyScalar(0.5);
  // Body scale comes from the composer's per-segment median when available.
  // Measured: this contributes ~0% of the frame-to-frame wrist jitter (the
  // raw wrist landmark dominates by an order of magnitude), so it is NOT the
  // drift fix — the EMA below is. It is kept because a per-segment constant
  // is the correct normaliser: within a clip the signer's skeleton cannot
  // change size, and holding it fixed keeps the mapping consistent when
  // consecutive signs come from signers of different build.
  const widthS = (body && body.width) || sgL.distanceTo(sgR);
  const torsoS = (body && body.torso) || sgMid.distanceTo(hgMid);
  if (widthS < 1e-3 || torsoS < 1e-3) return;
  const upS = sgMid.clone().sub(hgMid).normalize();
  let rightS = sgR.clone().sub(sgL);
  rightS.sub(upS.clone().multiplyScalar(rightS.dot(upS))).normalize();
  const fwdS = new THREE.Vector3().crossVectors(rightS, upS).normalize();

  // body-relative offset: normalized by shoulder width / torso length
  const bodyRel = v => {
    const o = v.clone().sub(sho);
    return {
      x: o.dot(rightS) / widthS,
      y: o.dot(upS) / torsoS,
      z: o.dot(fwdS) / torsoS,
    };
  };
  const rebuild = c =>
    BODY.shoulder[side].clone()
      .add(BODY.right.clone().multiplyScalar(c.x * BODY.width))
      .add(BODY.up.clone().multiplyScalar(c.y * BODY.torso))
      .add(BODY.fwd.clone().multiplyScalar(c.z * BODY.torso));

  const S = arm.upper.getWorldPosition(new THREE.Vector3());
  // Smooth the mapped targets, not the bone quaternions: position is a
  // linear space, so an EMA here removes landmark jitter without the
  // rotational lag that smoothing the quaternion introduces.
  // Measured on 辣's static hold: raw wrist landmark moves 0.00374/frame,
  // 0.00195 after this filter — 48% of the visible wander removed. This is
  // the main fix for the arm/wrist drift.
  const rel = smoothVec(`${side}:wri`, rebuild(bodyRel(wri)).sub(BODY.shoulder[side]), dt, TAU_TARGET);
  const maxReach = (arm.L1 + arm.L2) * 0.985;
  if (rel.length() > maxReach) rel.setLength(maxReach);
  // Collision correction is carried as a smoothed, persistent offset rather
  // than applied as an instant fix-up after the fact. Measured: the old
  // post-hoc lerp=1 correction snapped on and off as the hand crossed the
  // collision boundary and multiplied the arm's frame-to-frame jerk by 7.7x
  // on 看 — that was the arm shaking. Folding it into the target means one
  // aim per frame and a correction that ramps instead of popping.
  const corr = CORR[side] || (CORR[side] = new THREE.Vector3());
  const T = S.clone().add(rel).add(corr);
  const reach = T.clone().sub(S);
  if (reach.length() > maxReach) T.copy(S).add(reach.setLength(maxReach));

  // Elbow offset uses the same origin as the wrist above. The original
  // subtracted the LIVE shoulder S from a point rebuilt around the REST
  // shoulder, so any chest rotation leaked (BODY.shoulder − S) into the
  // pole vector and swung the elbow — visible as the shoulder/arm wander.
  const pole = smoothVec(`${side}:elb`, rebuild(bodyRel(elb)).sub(BODY.shoulder[side]), dt, TAU_TARGET);
  const pc = POLE_CORR[side];
  if (pc) pole.add(pc);   // swing the elbow clear of the torso

  arm.lastS = S.clone();
  arm.lastT = T.clone();
  arm.lastPole = pole.clone();
  aimArm(side, S, T, pole, lerp);
}

/* two-bone IK: place the elbow by law of cosines, steered by the pole hint,
 * then aim upper and lower arm. Split out of solveArm so the hand-collision
 * pass can re-run it against a corrected wrist target. */
function aimArm(side, S, T, pole, lerp) {
  const arm = ARM[side];
  const d = T.clone().sub(S);
  const dl = Math.max(d.length(), 1e-4);
  const dirn = d.clone().divideScalar(dl);
  const a = Math.min(Math.max((arm.L1 ** 2 - arm.L2 ** 2 + dl ** 2) / (2 * dl), -arm.L1), arm.L1);
  const h = Math.sqrt(Math.max(arm.L1 ** 2 - a * a, 0));
  let m = pole.clone().sub(dirn.clone().multiplyScalar(pole.dot(dirn)));
  if (m.lengthSq() < 1e-6) m = new THREE.Vector3(0, -1, 0.2);  // degenerate: elbow drops down
  m.normalize();
  const elbowPos = S.clone().add(dirn.clone().multiplyScalar(a)).add(m.multiplyScalar(h));

  aimBoneWorld(arm.upper, arm.restDirUpper, arm.restQUpper,
    elbowPos.clone().sub(S).normalize(), lerp);
  aimBoneWorld(arm.lower, arm.restDirLower, arm.restQLower,
    T.clone().sub(arm.lower.getWorldPosition(new THREE.Vector3())).normalize(), lerp);
}

/* ── hand-vs-body collision ──────────────────────────────────────────
 * Constraining the WRIST is not enough. Measured on this rig, the wrist
 * never enters the head sphere (closest 1.18x the radius) while the
 * fingertips reach 11.4cm against a 13.5cm head radius — 2cm inside the
 * face. That is the clipping the team saw.
 *
 * So after the hand is oriented, probe the actual finger bones, find the
 * deepest penetration, and translate the whole hand out by that amount by
 * re-aiming the arm. The finger bones are children of the wrist, so they
 * follow rigidly and the handshape is preserved exactly. */
/* Every finger joint is probed, not just the tips: a knuckle can enter the
 * chest while the fingertip stays clear. Filled in at model load, since
 * FINGER_CHAINS is declared further down the file. */
const HAND_PROBES = ["Hand"];

/* Finger segments used for hand-vs-hand testing, as a capsule chain. */
const FINGER_TIPS = ["ThumbDistal", "IndexDistal", "MiddleDistal", "RingDistal", "LittleDistal"];
const FINGER_MIDS = ["ThumbProximal", "IndexIntermediate", "MiddleIntermediate",
                     "RingIntermediate", "LittleIntermediate"];
const FINGER_R = 0.009;   // ~9mm per finger, so a pair clears at 18mm
const CORR = {};          // per side: smoothed collision offset, in avatar space
const POLE_CORR = {};     // per side: elbow pole offset, for forearm contacts
const TAU_CORR = 0.09;    // how fast the correction ramps in and releases
/* The correction is an integrator: each frame it adds whatever penetration
 * is left over. With a unit gain and no bound that winds up — measured on
 * 看, the offset ran away until the reach clamp caught it and the hand
 * jumped 91mm in a frame. A sub-unit gain makes it converge instead of
 * over-shooting, and the clamp is a hard backstop: a correction bigger than
 * this means the constraint cannot be satisfied, and freezing it there is
 * far better than launching the arm. */
const CORR_GAIN = 0.85;
const CORR_MAX = 0.07;    // metres

function bonePos(name, out) {
  const bone = vrm.humanoid.getNormalizedBoneNode(name);
  if (!bone) return null;
  bone.updateWorldMatrix(true, false);
  return out.setFromMatrixPosition(bone.matrixWorld);
}

/* Palm centre and radius for the hand-vs-hand test.
 * The radius is deliberately small — roughly the palm's half-thickness, not
 * its outline. Measured across 45 signs, legitimate two-handed contact signs
 * (接財神, 財神到我家大門口) bring the palm centres within 3.6–6cm, so a
 * generous sphere would fight signs that are supposed to touch. At 0.30 of
 * hand length the spheres only overlap when one palm is genuinely passing
 * through the other. */
const PALM_R = 0.30;

function palmSphere(side) {
  const w = bonePos(`${side}Hand`, new THREE.Vector3());
  const m = bonePos(`${side}MiddleProximal`, new THREE.Vector3())
    || bonePos(`${side}MiddleDistal`, new THREE.Vector3());
  if (!w || !m) return null;
  return { c: w.clone().lerp(m, 0.6), r: w.distanceTo(m) * PALM_R };
}

/* One pass for every contact constraint. Each side accumulates a desired
 * offset, which is then eased into CORR so the arm never jumps. */
function updateCollisionCorrections(dt) {
  const alpha = smoothAlpha(dt, TAU_CORR);
  const want = { left: new THREE.Vector3(), right: new THREE.Vector3() };
  const p = new THREE.Vector3();

  // 1. hand vs body (head sphere + torso ellipse), deepest probe point wins
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    const corr = CORR[side] || (CORR[side] = new THREE.Vector3());
    if (!arm || !arm.lastT) continue;
    // Deepest probe wins. Averaging over all 16 joints was measurably worse
    // (torso 0.81 → 0.73): most probes sit outside and contribute nothing,
    // and pushes on opposite sides of a finger partly cancel, so the mean
    // under-corrects the one joint that is actually buried.
    let deepest = null, depth = 0;
    for (const name of HAND_PROBES) {
      if (!bonePos(`${side}${name}`, p)) continue;
      const q = pushOutOfBody(p);
      const d = q.distanceTo(p);
      if (d > depth) { depth = d; deepest = q.clone().sub(p); }
    }
    // the probe already reflects the correction in force, so the offset we
    // want is the current one plus what is still left, damped by the gain
    if (deepest) want[side].copy(corr).add(deepest.multiplyScalar(CORR_GAIN));
  }

  // 2. forearm vs body. The hand probes above cannot fix this: the elbow is
  // placed by the pole vector, so a forearm lying against the torso needs
  // the ELBOW swung out, not the wrist moved. Sampled along its length and
  // fed to a separate pole correction.
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    const pc = POLE_CORR[side] || (POLE_CORR[side] = new THREE.Vector3());
    if (!arm || !arm.lastT) { pc.multiplyScalar(1 - alpha); continue; }
    const e = arm.lower.getWorldPosition(new THREE.Vector3());
    const w = arm.hand.getWorldPosition(new THREE.Vector3());
    const sum = new THREE.Vector3();
    let hits = 0;
    for (let k = 1; k <= 3; k++) {          // skip the endpoints, they are covered
      const q = e.clone().lerp(w, k / 4);
      const out = pushOutOfBody(q);
      const d = out.distanceTo(q);
      if (d > 1e-5) { sum.add(out.sub(q)); hits++; }
    }
    const wantPole = hits
      ? pc.clone().add(sum.divideScalar(hits).multiplyScalar(CORR_GAIN))
      : new THREE.Vector3();
    pc.lerp(wantPole, alpha);
    if (pc.length() > CORR_MAX) pc.setLength(CORR_MAX);
  }

  // 3. hand vs hand, per finger. Palm-sphere separation was too coarse:
  // measured, the palms sit 8.4cm apart on 我想去日本玩 while the fingers
  // still interleave, so the overlap has to be found at finger level.
  // Only the smallest violation drives the push, and the two hands share it
  // symmetrically so neither is singled out.
  if (ARM.left.lastT && ARM.right.lastT) {
    const gather = side => {
      const pts = [];
      for (const nm of [...FINGER_TIPS, ...FINGER_MIDS, "Hand"]) {
        const v = bonePos(`${side}${nm}`, new THREE.Vector3());
        if (v) pts.push(v.clone());
      }
      return pts;
    };
    const L = gather("left"), R = gather("right");
    let worst = null, overlap = 0;
    for (const a of L) for (const b of R) {
      const d = b.clone().sub(a);
      const dist = d.length();
      const min = FINGER_R * 2;
      if (dist < min && min - dist > overlap) {
        overlap = min - dist;
        worst = (dist > 1e-5 ? d.divideScalar(dist) : new THREE.Vector3(1, 0, 0));
      }
    }
    if (worst) {
      const half = worst.multiplyScalar(overlap / 2);
      want.right.add(half);
      want.left.sub(half);
    }
  }

  // ease toward the wanted offset; when nothing collides `want` is zero, so
  // the correction relaxes back out on its own
  for (const side of ["left", "right"]) {
    const corr = CORR[side] || (CORR[side] = new THREE.Vector3());
    corr.lerp(want[side], alpha);
    if (corr.length() > CORR_MAX) corr.setLength(CORR_MAX);  // anti-windup
  }
}

function rigRotation(name, rot, dampener = 1, lerp = 0.35) {
  const bone = vrm.humanoid.getNormalizedBoneNode(name);
  if (!bone || !rot) return;
  const q = new THREE.Quaternion().setFromEuler(
    new THREE.Euler(
      TUNE.fx * rot.x * dampener,
      TUNE.fy * rot.y * dampener,
      TUNE.fz * rot.z * dampener,
      "XYZ",
    ),
  );
  bone.quaternion.slerp(q, lerp);
}

/* Finger landmarks are the noisiest thing we record: on 辣 the index
 * fingertip carries 0.046 of high-frequency jitter per frame (hand-size
 * units), and 父親 throws 0.67 spikes when tracking briefly loses the hand.
 * Fingers therefore get a longer time constant than the arm, plus a cap on
 * how far a single frame may rotate a joint, which absorbs the dropouts
 * without visibly softening real handshape changes. */
const TAU_FINGER = 0.075;

/* ── finger solve ────────────────────────────────────────────────────
 * Kalidokit's Hand.solve reduces each finger to curl/spread angles and
 * rebuilds Euler rotations from them, which is lossy: handshape is
 * phonemic in sign language, and the flattening blurs exactly the
 * distinctions that separate one sign from another.
 *
 * We have all 21 landmarks per hand, so solve the chain directly instead:
 * every bone is aimed along the measured joint-to-joint direction, the same
 * way the arm is retargeted. The measured direction is expressed in the
 * signer's palm frame, mapped into the avatar's rest palm frame, then
 * carried by however the avatar's hand is actually oriented right now. */
const FINGER_CHAINS = {
  Thumb: ["Metacarpal", "Proximal", "Distal"],
  Index: ["Proximal", "Intermediate", "Distal"],
  Middle: ["Proximal", "Intermediate", "Distal"],
  Ring: ["Proximal", "Intermediate", "Distal"],
  Little: ["Proximal", "Intermediate", "Distal"],
};
/* landmark index per joint; bone i spans lm[i] → lm[i+1] */
const FINGER_LANDMARKS = {
  Thumb: [1, 2, 3, 4],
  Index: [5, 6, 7, 8],
  Middle: [9, 10, 11, 12],
  Ring: [13, 14, 15, 16],
  Little: [17, 18, 19, 20],
};
const FINGER_MAX_DEG = 100;   // per joint, generous but stops hyperextension
const FINGER_REST = {};

function captureFingerRest() {
  for (const k of Object.keys(FINGER_REST)) delete FINGER_REST[k];
  HAND_PROBES.length = 1;   // keep "Hand", then every finger joint
  for (const [finger, segs] of Object.entries(FINGER_CHAINS))
    for (const s of segs) HAND_PROBES.push(`${finger}${s}`);
  for (const side of ["left", "right"]) {
    for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
      for (let i = 0; i < segs.length; i++) {
        const name = `${side}${finger}${segs[i]}`;
        const bone = vrm.humanoid.getNormalizedBoneNode(name);
        if (!bone) continue;
        const p = bone.getWorldPosition(new THREE.Vector3());
        let tip;
        if (bone.children[0]) {
          tip = bone.children[0].getWorldPosition(new THREE.Vector3());
        } else if (i > 0) {
          // Distal has no tip node on these models: continue the previous
          // segment's direction by its own length
          const prev = vrm.humanoid.getNormalizedBoneNode(`${side}${finger}${segs[i - 1]}`);
          const pp = prev ? prev.getWorldPosition(new THREE.Vector3()) : null;
          tip = pp ? p.clone().add(p.clone().sub(pp)) : null;
        }
        if (!tip) continue;
        const dir = tip.sub(p);
        if (dir.lengthSq() < 1e-10) continue;
        FINGER_REST[name] = {
          dir: dir.normalize(),
          q: bone.getWorldQuaternion(new THREE.Quaternion()),
        };
      }
    }
  }
}

/* aim a bone at a world direction, limiting how far it may leave its rest */
function aimBoneClamped(bone, restDir, restQ, targetDir, lerp, maxDeg) {
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const delta = new THREE.Quaternion().setFromUnitVectors(restDir, targetDir);
  const local = parentQ.invert().multiply(delta.multiply(restQ.clone()));
  bone.quaternion.slerp(clampSwing(local, maxDeg), lerp);
  bone.updateWorldMatrix(true, true);
}

function solveFingers(side, worldLms, dt) {
  const arm = ARM[side];
  if (!arm || !arm.restPalm || !worldLms) return;
  // rotation taking the signer's palm frame onto the avatar's rest palm frame
  const Bm = palmBasis(mpToAvatar(worldLms[0]), mpToAvatar(worldLms[9]),
    mpToAvatar(worldLms[5]), mpToAvatar(worldLms[17]));
  const alignQ = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().multiplyMatrices(arm.restPalm, new THREE.Matrix4().copy(Bm).invert()),
  );
  // ...and then however the avatar's hand has actually moved since rest
  const R = arm.hand.getWorldQuaternion(new THREE.Quaternion())
    .multiply(arm.restQHand.clone().invert());
  const alpha = smoothAlpha(dt, TAU_FINGER);

  for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
    const lm = FINGER_LANDMARKS[finger];
    for (let i = 0; i < segs.length; i++) {
      const name = `${side}${finger}${segs[i]}`;
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      const rest = FINGER_REST[name];
      if (!bone || !rest) continue;
      const a = mpToAvatar(worldLms[lm[i]]);
      const b = mpToAvatar(worldLms[lm[i + 1]]);
      const d = b.sub(a);
      if (d.lengthSq() < 1e-10) continue;
      d.normalize().applyQuaternion(alignQ).applyQuaternion(R);
      aimBoneClamped(bone, rest.dir, rest.q, d, alpha, FINGER_MAX_DEG);
    }
  }
}

/* ── wrist twist redistribution ──────────────────────────────────────
 * Measured on 我想去日本玩: the wrist bone was carrying a mean local
 * rotation of 119°(L)/136°(R), peaking at 178°. A real wrist manages about
 * ±80° of flexion and almost no axial twist, so the skin cluster around it
 * collapsed — the "deformed hand".
 *
 * The cause is upstream: aimBoneWorld orients the forearm with a
 * minimal-arc rotation, which leaves its ROLL arbitrary. Forearm pronation
 * is then unaccounted for, and the wrist has to absorb all of it.
 *
 * So decompose the wrist's required rotation about the forearm's own axis,
 * hand the twist component to the forearm (which is what pronates in a real
 * arm), and leave the wrist only the residual bend — clamped to a plausible
 * range. Palm orientation is phonemic in sign language, so this also makes
 * the signs read correctly rather than merely stopping the mesh breaking. */
const MAX_WRIST_DEG = 80;

/* split q into a rotation about `axis` and the remainder, such that
 * q = twist · rest  (twist on the left, so it can be moved to the parent) */
function twistAbout(q, axis) {
  const p = new THREE.Vector3(q.x, q.y, q.z);
  const proj = axis.clone().multiplyScalar(p.dot(axis));
  const twist = new THREE.Quaternion(proj.x, proj.y, proj.z, q.w);
  if (twist.lengthSq() < 1e-8) return new THREE.Quaternion();
  return twist.normalize();
}

function clampSwing(q, maxDeg) {
  const w = Math.min(1, Math.abs(q.w));
  const ang = 2 * Math.acos(w);
  const lim = maxDeg * Math.PI / 180;
  if (ang <= lim) return q;
  return q.clone().slerp(new THREE.Quaternion(), 1 - lim / ang);
}

function rigHand(side, handLms, worldLms, dt = 0.016) {
  const lower = side.toLowerCase();

  // wrist orientation: exact palm plane from the world landmarks
  const arm = ARM[lower];
  if (arm && arm.restPalm && worldLms) {
    const w = mpToAvatar(worldLms[0]);
    const basis = palmBasis(w, mpToAvatar(worldLms[9]), mpToAvatar(worldLms[5]), mpToAvatar(worldLms[17]));
    const delta = new THREE.Quaternion()
      .setFromRotationMatrix(basis)
      .multiply(new THREE.Quaternion().setFromRotationMatrix(arm.restPalm).invert());
    const parentQ = arm.hand.parent.getWorldQuaternion(new THREE.Quaternion());
    const local = parentQ.clone().invert().multiply(delta.multiply(arm.restQHand.clone()));

    // the forearm's long axis, in the forearm's own space, is simply the
    // direction of the hand bone's rest offset
    const axis = arm.hand.position.lengthSq() > 1e-9
      ? arm.hand.position.clone().normalize()
      : new THREE.Vector3(1, 0, 0);
    const twist = twistAbout(local, axis);
    const residual = twist.clone().invert().multiply(local);

    // roll the forearm by the twist, then the wrist only bends
    const alpha = smoothAlpha(dt, TAU_ARM);
    const lowerTarget = arm.lower.quaternion.clone().multiply(twist);
    arm.lower.quaternion.slerp(lowerTarget, alpha);
    arm.lower.updateWorldMatrix(true, true);
    arm.hand.quaternion.slerp(clampSwing(residual, MAX_WRIST_DEG), alpha);
  }

  // handshape straight from the 21 landmarks
  solveFingers(lower, worldLms, dt);
}

/* subtle torso life: chest roll from the shoulder line, yaw from shoulder
 * depth difference — keeps the trunk from looking like a statue */
function rigTorso(poseWorld, dt = 0.016) {
  const sL = mpToAvatar(poseWorld[11]);
  const sR = mpToAvatar(poseWorld[12]);
  // Smooth the shoulder line before deriving chest angles. The arms hang off
  // the chest, so any jitter here is amplified along the whole arm; a long
  // time constant keeps the "torso is alive" cue without shaking the hands.
  // Measured: shoulder landmark moves 0.00081/frame raw, 0.00021 filtered.
  const d = smoothVec("torso:line", sR.clone().sub(sL), dt, TAU_CHEST);
  rigRotation("chest", {
    x: 0,
    y: -Math.atan2(d.z, Math.abs(d.x)) * 0.5,  // one shoulder forward → slight turn
    z: Math.atan2(d.y, Math.abs(d.x)) * 0.6,   // shoulder tilt → slight lean
  }, 1, smoothAlpha(dt, TAU_CHEST));
  const chest = vrm.humanoid.getNormalizedBoneNode("chest");
  if (chest) chest.updateWorldMatrix(true, true);  // arms read fresh shoulder positions
}

/* head orientation straight from ear/nose geometry (we store no face
 * landmarks); expects unmirrored (native-convention) landmarks */
function rigHead(poseLms) {
  const nose = poseLms[0], lEar = poseLms[7], rEar = poseLms[8];
  const earMidX = (lEar.x + rEar.x) / 2;
  const earMidY = (lEar.y + rEar.y) / 2;
  const earDist = Math.hypot(lEar.x - rEar.x, lEar.y - rEar.y) || 1e-3;
  rigRotation("head", {
    x: (nose.y - earMidY) / earDist - 0.45,           // pitch: nose sits below the ear line
    y: (nose.x - earMidX) / earDist * 1.4,            // yaw
    z: Math.atan2(lEar.y - rEar.y, lEar.x - rEar.x),  // roll along the ear line
  }, 0.8, 0.3);
}

/* ── expressions ─────────────────────────────────────────────────────
 * The recordings carry all 52 ARKit blendshapes and 24–28 of them actually
 * move, but only 7 were ever read. Worse, the brow-raise was written to
 * "surprised", and on these VRM0 models the expression is registered under
 * the custom name "Surprised" — so setValue silently did nothing and the
 * yes/no question marker never appeared at all.
 *
 * Expression names differ per model (VRM0 presets migrate to VRM1 names,
 * custom groups keep their author's capitalisation), so resolve them once
 * against what this model actually exposes and match case-insensitively. */
const EXPR = { lookup: new Map() };

function resolveExpressions() {
  EXPR.lookup = new Map();
  const em = vrm.expressionManager;
  if (!em) return;
  for (const e of em.expressions) EXPR.lookup.set(e.expressionName.toLowerCase(), e.expressionName);
}

const TAU_FACE = 0.055;
const FACE_VAL = {};

function resetFace() {
  for (const k of Object.keys(FACE_VAL)) delete FACE_VAL[k];
}

/* recorded ARKit blendshapes → whatever this VRM actually has */
function rigFace(bs, dt = 0.016) {
  const em = vrm.expressionManager;
  if (!em) return;
  const v = n => (bs && bs[n]) || 0;
  const set = (want, val) => {
    const name = EXPR.lookup.get(want.toLowerCase());
    if (!name) return;
    const tgt = Math.min(1, Math.max(0, val));
    const prev = FACE_VAL[name];
    // smooth: raw blendshapes flicker frame to frame just like the landmarks
    const nv = prev === undefined ? tgt : prev + (tgt - prev) * smoothAlpha(dt, TAU_FACE);
    FACE_VAL[name] = nv;
    em.setValue(name, nv);
  };

  const smile = Math.max(v("mouthSmileLeft"), v("mouthSmileRight"));
  const browDown = Math.max(v("browDownLeft"), v("browDownRight"));
  const browUp = Math.max(v("browInnerUp"), v("browOuterUpLeft"), v("browOuterUpRight"));
  const frown = Math.max(v("mouthFrownLeft"), v("mouthFrownRight"));

  set("blinkLeft", v("eyeBlinkLeft"));
  set("blinkRight", v("eyeBlinkRight"));

  // visemes: jaw drives aa, the lip shapes pick the rest
  set("aa", v("jawOpen") * 1.3);
  set("ou", v("mouthPucker") * 0.9);
  set("oh", v("mouthFunnel") * 1.1);
  set("ee", Math.max(v("mouthStretchLeft"), v("mouthStretchRight")) * 0.8);
  set("ih", Math.max(v("mouthUpperUpLeft"), v("mouthUpperUpRight"),
                     v("mouthLowerDownLeft"), v("mouthLowerDownRight")) * 0.7);

  // Non-manual markers. These are grammar in TSL, not decoration: brow-down
  // marks wh-questions, brow-up marks yes/no. Emotion presets on VRoid models
  // move brow+eye+mouth together, so keep the gain moderate — we want the
  // brows to read, not the avatar to look angry or astonished.
  set("angry", browDown * 0.75);
  set("Surprised", browUp * 0.85);
  set("happy", smile * 0.7);
  set("sad", frown * 0.6);

  // gaze, on models that expose it (orion does; VRoid ones don't)
  set("lookDown", Math.max(v("eyeLookDownLeft"), v("eyeLookDownRight")) * 0.7);
  set("lookUp", Math.max(v("eyeLookUpLeft"), v("eyeLookUpRight")) * 0.7);
  set("lookLeft", Math.max(v("eyeLookOutLeft"), v("eyeLookInRight")) * 0.7);
  set("lookRight", Math.max(v("eyeLookOutRight"), v("eyeLookInLeft")) * 0.7);
}

function update(frame, dt) {
  if (!ready || !frame) return;
  vrm.scene.rotation.y = Math.PI + TUNE.sceneYaw;

  const step = Math.min(Math.max(dt || 0.016, 1e-4), 0.1);  // clamp: tab-switch stalls
  if (frame.pose) {
    const vis = frame.pose.visibility;
    const visOK = i => (vis ? vis[i] : 1) >= 0.4;
    const hasHand = side => (frame.hands || []).some(h => h.handedness.toLowerCase() === side);
    const body = frame._body || null;  // composer's per-segment median body scale
    rigTorso(frame.pose.world_landmarks, step);
    solveArm("left", frame.pose.world_landmarks, visOK, hasHand("left"), body, step);
    solveArm("right", frame.pose.world_landmarks, visOK, hasHand("right"), body, step);
    rigHead(poseLm(frame.pose.landmarks, frame.pose.visibility, false));
  }
  for (const h of frame.hands || [])
    rigHand(h.handedness, handLm(h.landmarks), h.world_landmarks, step);
  // after the handshape exists, measure contacts and ease the correction
  // that solveArm will apply (one frame of lag, but no popping)
  updateCollisionCorrections(step);
  rigFace(frame.face ? frame.face.blendshapes : null, step);
  vrm.update(dt || 0.016);
}

function setCamera(c) {
  if (!cam) return;
  // reuse the 2D stage's orbit params; scale its dist into avatar framing
  const safeAspectScale = Math.max(1, SAFE_STAGE_ASPECT / Math.max(cam.aspect, 0.01));
  const dist = baseDist * (c.dist / BASE_2D_DIST) * safeAspectScale;
  cam.position.set(
    TARGET.x + dist * Math.cos(c.pitch) * Math.sin(c.yaw),
    TARGET.y + dist * Math.sin(c.pitch),
    TARGET.z + dist * Math.cos(c.pitch) * Math.cos(c.yaw),
  );
  cam.lookAt(TARGET);
}

function resize(w, h) {
  if (!renderer) return;
  renderer.setSize(w, h, false);
  cam.aspect = w / h;
  cam.updateProjectionMatrix();
}

function render() {
  if (renderer && ready) renderer.render(scene, cam);
}

window.Avatar3D = {
  init,
  loadModel,
  update,
  setCamera,
  resize,
  render,
  resetSmoothing,
  tune: TUNE,
  get vrm() { return vrm; },  // console calibration: expressions, bones, morphs
  get volumes() { return VOL; },
  get pushStats() { return PUSH_STATS; },
  get expressionNames() { return [...EXPR.lookup.values()]; },
  smoothing: { get TAU_TARGET() { return TAU_TARGET; }, get TAU_ARM() { return TAU_ARM; } },
  get ready() { return ready; },
};
