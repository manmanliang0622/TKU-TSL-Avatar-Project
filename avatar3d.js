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
        fitLimbVolumes();
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
const TUNE = { unmirror: true, fx: 1, fy: 1, fz: 1, swapSides: false, hipsYaw: 0, sceneYaw: 0,
  /* live-tunable retarget gains, so they can be measured rather than guessed */
  fingerContrast: 0.55, fingerGap: 0.62, dipBand: 1, separate: 1,
  moveGain: 1.35, tauTarget: 0.055, tauArm: 0.040, twistSoft: 80, twistToHand: 35,
  collide: 1, pairGeom: 1, palmTau: 0 };

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
  // right × up comes out pointing at the avatar's BACK (measured: (0,0,-0.99)
  // with the face toward +z). The mapping in solveArm only needs the signer and
  // the avatar to agree, so it uses BODY.fwd as-is — but the joint limits below
  // are anatomical and need the real front.
  BODY.front = BODY.fwd.clone().negate();

  captureJointAxes();
  captureShoulders();
}

/* ── shoulder line ───────────────────────────────────────────────────
 * The clavicles were never driven, so the shoulders sat wherever the model's
 * bind pose left them — on this rig, sloping steeply down from the neck, which
 * reads as narrow and round-shouldered next to a real signer.
 *
 * They are now held at a FIXED elevation: set every frame from a constant, so
 * nothing in the retarget can shift them and the shoulder line stays put
 * whatever the arms do. Raising the outer end is the only lever a rotation
 * gives — a joint cannot be translated outward without breaking the rig — but
 * flattening the slope is what actually reads as a broader shoulder. */
const SHOULDER = {};
/* ── scapulohumeral rhythm ───────────────────────────────────────────
 * Holding the clavicle at a constant angle is what was distorting the
 * shoulder. In a real shoulder the girdle does not stay put while the arm
 * rises: past a setting phase of about the first 30 degrees of elevation, the
 * scapula rotates with the humerus in roughly a 2:1 ratio, so a 180 degree
 * elevation is about 120 degrees at the glenohumeral joint and 60 at the
 * scapulothoracic one, with the clavicle itself elevating up to about 15
 * degrees. Freezing it meant the humerus alone had to cover the whole range,
 * and past shoulder height the deltoid skinning collapsed.
 *
 * So the clavicle now follows the arm by that rule. SHOULDER_BASE_DEG is a
 * small constant on top, which is the part that squares off the shoulder line
 * — that is cosmetic, not anatomical, and is kept deliberately small.
 * (Numbers: Physiopedia / OrthoFixar on scapulohumeral rhythm.) */
const SHOULDER_BASE_DEG = 6;      // cosmetic: flattens a very sloped shoulder
const SHOULDER_SETTING_DEG = 30;  // elevation below which the girdle stays put
const SHOULDER_RATIO = 0.4;       // scapular share of elevation past the setting phase
const SHOULDER_MAX_DEG = 16;      // bounded by the clavicle's own range
const TAU_SHOULDER = 0.12;

function captureShoulders() {
  for (const side of ["left", "right"]) {
    const bone = vrm.humanoid.getNormalizedBoneNode(`${side}Shoulder`);
    if (!bone) continue;
    SHOULDER[side] = {
      bone,
      restQ: bone.getWorldQuaternion(new THREE.Quaternion()),
      // rotating the outboard direction about body-front lifts it; the two
      // sides point opposite ways along BODY.right, so they need opposite signs
      sign: side === "right" ? 1 : -1,
    };
  }
}

function holdShoulders(dt) {
  const alpha = smoothAlpha(dt, TAU_SHOULDER);
  for (const side of ["left", "right"]) {
    const s = SHOULDER[side];
    const arm = ARM[side];
    if (!s || !arm) continue;
    // where the arm is now, read from last frame's pose. Using it here rather
    // than after the IK avoids a circular dependency and costs one frame.
    const S = arm.upper.getWorldPosition(new THREE.Vector3());
    const E = arm.lower.getWorldPosition(new THREE.Vector3());
    const dir = E.sub(S);

    // start from the cosmetic base lift, which is what squares off a sloped
    // shoulder line and is present even with the arm hanging
    const want = new THREE.Quaternion().setFromAxisAngle(
      BODY.front, s.sign * SHOULDER_BASE_DEG * Math.PI / 180);

    if (dir.lengthSq() > 1e-8) {
      dir.normalize();
      const elev = Math.acos(Math.min(1, Math.max(-1,
        dir.dot(BODY.up.clone().negate())))) * 180 / Math.PI;
      const share = Math.min(SHOULDER_MAX_DEG,
        Math.max(0, (elev - SHOULDER_SETTING_DEG) * SHOULDER_RATIO));
      // ...about the axis the arm is ACTUALLY swinging on, not a fixed
      // elevation axis. The girdle does not only lift: measured 3D kinematics
      // put it at 11-15 deg of elevation, 15-29 of retraction and 15-31 of
      // posterior axial rotation through a full arm elevation. Taking the
      // share along the humerus' own swing axis reproduces whichever of those
      // the current reach calls for, which is what stops a forward reach
      // looking like the arm has left the socket.
      const axis = new THREE.Vector3().crossVectors(arm.restDirUpper, dir);
      if (axis.lengthSq() > 1e-8 && share > 0) {
        want.multiply(new THREE.Quaternion()
          .setFromAxisAngle(axis.normalize(), share * Math.PI / 180));
      }
    }

    const parentQ = s.bone.parent.getWorldQuaternion(new THREE.Quaternion());
    const local = parentQ.invert().multiply(want).multiply(s.restQ);
    s.bone.quaternion.slerp(local, alpha);
    s.bone.updateWorldMatrix(true, true);
  }
}

/* ── anatomical axes, per side ───────────────────────────────────────
 * A minimal-arc aim (aimLocal) fixes where a bone POINTS and leaves its
 * roll arbitrary. For the upper arm that roll is what decides which way the
 * elbow creases, and for the forearm it is pronation. Both were unconstrained,
 * so the elbow could bend sideways and the forearm wound up past a full turn
 * (measured on 玩: 717° of accumulated roll in one sign).
 *
 * These are the reference directions that pin both down. They live in the
 * PARENT bone's local frame, which is legitimate on a normalized VRM rig
 * because every humanoid bone's rest local rotation is identity — so a local
 * direction captured here stays meaningful however the bone later moves. */
function captureJointAxes() {
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    // long axes: a child bone's rest offset IS its parent's long axis
    arm.axisUpper = arm.lower.position.lengthSq() > 1e-9
      ? arm.lower.position.clone().normalize() : new THREE.Vector3(1, 0, 0);
    arm.axisLower = arm.hand.position.lengthSq() > 1e-9
      ? arm.hand.position.clone().normalize() : new THREE.Vector3(1, 0, 0);

    // Elbow hinge reference: with the arm in its rest orientation a human
    // elbow folds toward the front of the body. Carried into the upper arm's
    // local frame, this says which way the crease must face for any pose.
    arm.bendUpper = orthonormal(
      BODY.front.clone().applyQuaternion(arm.restQUpper.clone().invert()), arm.axisUpper);

    // Wrist limits are anisotropic, so the wrist needs its own palm frame:
    // N = palm normal, C = across the palm. Bending about C is flexion /
    // extension (the big range), about N is radial / ulnar deviation (small).
    if (arm.restPalm) {
      const n = new THREE.Vector3().setFromMatrixColumn(arm.restPalm, 1)
        .applyQuaternion(arm.restQLower.clone().invert());
      arm.palmN = orthonormal(n, arm.axisLower);
      arm.palmC = new THREE.Vector3().crossVectors(arm.axisLower, arm.palmN).normalize();
    }
  }
}

/* component of v perpendicular to axis, normalized; falls back to any
 * perpendicular when the two are parallel */
function orthonormal(v, axis) {
  const out = v.clone().sub(axis.clone().multiplyScalar(v.dot(axis)));
  if (out.lengthSq() < 1e-8) {
    const alt = Math.abs(axis.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    out.crossVectors(axis, alt);
  }
  return out.normalize();
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

  // 0.97, not 0.9. The 90th percentile is dragged inward by the vertices of
  // every layer UNDER the outer garment — skin, the top, the cardigan lining —
  // so it fitted a surface inside the coat. Measured against this model, the
  // real outer surface sits at 1.12-1.50x the p90 radius in every band, which
  // is precisely how far a palm could sink into the clothing while the solver
  // believed it was resting on the body.
  const rxs = torsoX.map(v => pct(v, 0.97));
  const rzs = torsoZ.map(v => pct(v, 0.97));
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

/* ── limb thickness ──────────────────────────────────────────────────
 * The body volumes above only ever answered "is this POINT inside the body".
 * An arm is not a point. Measured on this model the upper arm is 4.0cm thick
 * at the median vertex (5.2cm at the 75th percentile) and the forearm 2.9cm
 * (4.4cm), so a centreline sitting 2cm clear of the chest still buries half
 * the limb in it — which is exactly what was happening: the proximal half of
 * the humerus was inside the torso surface in the MEDIAN frame, on both sides.
 *
 * Radii come from the model's own skinned vertices, grouped by the bone that
 * dominates each one. The 75th percentile, not the max: the deltoid and the
 * elbow bulge sit near the joints, where the shoulder is legitimately inside
 * the torso and an inflated radius would just shove the arm out permanently. */
const LIMB = { upper: 0.045, lower: 0.035 };  // metres; refit per model on load

function fitLimbVolumes() {
  // Which humanoid segment each vertex belongs to is decided by walking its
  // dominant skinning bone up to a known arm bone. Bone NAMES are no help
  // here — VRoid rigs spell the sides "J_Bip_L_/R_", other exporters use
  // other conventions — so identity is tracked by node, not by name.
  const seg = {};   // uuid of an arm bone → { key, ends: [from, to] }
  for (const side of ["left", "right"]) {
    for (const [key, ends] of [["upper", ["UpperArm", "LowerArm"]],
                               ["lower", ["LowerArm", "Hand"]]]) {
      const from = vrm.humanoid.getRawBoneNode(`${side}${ends[0]}`);
      const to = vrm.humanoid.getRawBoneNode(`${side}${ends[1]}`);
      if (from && to) seg[from.uuid] = { key, from, to };
    }
    // The walk has to stop at the wrist. Every finger vertex sits under the
    // hand, which sits under the forearm, so without this the whole hand is
    // measured as forearm thickness — which put the "forearm radius" at 10cm.
    const hand = vrm.humanoid.getRawBoneNode(`${side}Hand`);
    if (hand) seg[hand.uuid] = null;
  }
  const segOf = node => {
    let n = node;
    for (let d = 0; n && d < 40; d++, n = n.parent)
      if (n.uuid in seg) return seg[n.uuid];
    return null;
  };
  const radii = { upper: [], lower: [] };
  const v = new THREE.Vector3();

  vrm.scene.traverse(o => {
    const g = o.geometry;
    if (!o.isSkinnedMesh || !o.skeleton || !g || !g.attributes.skinIndex) return;
    const { skinIndex: si, skinWeight: sw, position: p } = g.attributes;
    const perBone = o.skeleton.bones.map(segOf);
    // Bind-pose space throughout: skinned vertex positions are stored against
    // the bind pose, so they must be measured against the bind-pose skeleton
    // (bindMatrix / boneInverses) and never against the bones as posed now.
    const bind = new Map();
    o.skeleton.bones.forEach((b, i) => {
      bind.set(b.uuid, new THREE.Vector3()
        .setFromMatrixPosition(new THREE.Matrix4().copy(o.skeleton.boneInverses[i]).invert()));
    });
    const stride = Math.max(1, Math.floor(p.count / 4000));
    for (let i = 0; i < p.count; i += stride) {
      let best = 0, bw = -1;
      for (const c of ["X", "Y", "Z", "W"]) {
        const w = sw[`get${c}`](i);
        if (w > bw) { bw = w; best = si[`get${c}`](i); }
      }
      const s = perBone[best];
      if (!s) continue;
      const a = bind.get(s.from.uuid), b = bind.get(s.to.uuid);
      if (!a || !b) continue;
      v.set(p.getX(i), p.getY(i), p.getZ(i)).applyMatrix4(o.bindMatrix);
      const ax = b.clone().sub(a);
      let u = v.clone().sub(a).dot(ax) / Math.max(ax.lengthSq(), 1e-8);
      u = Math.min(Math.max(u, 0), 1);
      radii[s.key].push(v.distanceTo(a.clone().add(ax.multiplyScalar(u))));
    }
  });

  for (const key of ["upper", "lower"]) {
    const a = radii[key].sort((x, y) => x - y);
    if (a.length > 20) LIMB[key] = a[Math.floor(a.length * 0.75)];
  }
}

/* push a point out of the fitted volumes; returns the corrected point.
 * `extra` is the probe's own radius, for limbs that are not points. */
const SKIN = 0.02;  // ~half a hand thickness, so the palm rests on the surface

const PUSH_STATS = { calls: 0, hits: 0, headHits: 0, torsoHits: 0, maxPush: 0, sumPush: 0,
                     minHeadRatio: Infinity, minTorsoRatio: Infinity };

function pushOutOfBody(p, extra = 0) {
  const out = p.clone();
  PUSH_STATS.calls++;
  const h = VOL.head;
  if (h) {
    const d = out.clone().sub(h.c);
    const len = d.length();
    const min = h.r + SKIN + extra;
    // ratios describe the hand probes; a limb probe carries its own radius and
    // would read as a penetration at any sane clearance
    if (!extra) PUSH_STATS.minHeadRatio = Math.min(PUSH_STATS.minHeadRatio, len / min);
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
    const rx = (t.rxs[i0] + (t.rxs[i1] - t.rxs[i0]) * k) + SKIN + extra;
    const rz = (t.rzs[i0] + (t.rzs[i1] - t.rzs[i0]) * k) + SKIN + extra;
    const nx = radial.x / rx, nz = radial.z / rz;
    const e = Math.hypot(nx, nz);
    if (!extra) PUSH_STATS.minTorsoRatio = Math.min(PUSH_STATS.minTorsoRatio, e);
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
  const n = new THREE.Vector3().crossVectors(f, across);
  // A closed or edge-on hand can put index, little and the palm axis nearly in
  // line; |f x across| then collapses and the normalize() below amplifies pure
  // tracking noise into a wildly wrong palm frame. Measured, this bottoms out
  // at 0.157 on real clips, so the caller is told to skip the frame instead.
  if (n.length() < PALM_MIN_SIN) return null;
  n.normalize();
  const a = new THREE.Vector3().crossVectors(f, n);
  return new THREE.Matrix4().makeBasis(f, n, a);
}
const PALM_MIN_SIN = 0.25;

/* Stored (mirrored) MediaPipe world coords → avatar display space.
 * MediaPipe: x right, y down, z more NEGATIVE toward the camera.
 * Avatar:    x screen-right, y up, z toward the camera. */
const mpToAvatar = p => new THREE.Vector3(-p[0], -p[1], -p[2]);

/* the local rotation that points `bone` along targetDir, with no roll about
 * its own axis (a minimal-arc / swing-only solve) */
function aimLocal(bone, restDir, restQ, targetDir) {
  const parentQ = bone.parent.getWorldQuaternion(new THREE.Quaternion());
  const delta = new THREE.Quaternion().setFromUnitVectors(restDir, targetDir);
  return parentQ.invert().multiply(delta.multiply(restQ.clone()));
}

/* quaternion rotating `rad` radians about a local axis */
const rollQuat = (axis, rad) => new THREE.Quaternion().setFromAxisAngle(axis, rad);

/* signed angle from a to b about axis (all unit, a and b ⟂ axis) */
function signedAngle(a, b, axis) {
  return Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(axis), a.dot(b));
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
const MOVE_GAIN = 1.35;    // how much the moving part of a stroke is enlarged
const MOVE_TAU = 0.55;     // what counts as "the centre" a stroke moves around
const MOVE_MAX = 0.06;     // metres of extra travel, so a stroke cannot fly off
const UP_TILT_MAX_Z = 0.04;  // sin of ~2.3°: corpus signers stand upright; depth says otherwise

const SMOOTH = {};  // per side: smoothed target + pole, in avatar space

function resetSmoothing() {
  for (const k of Object.keys(SMOOTH)) delete SMOOTH[k];
  for (const k of Object.keys(CORR)) delete CORR[k];
  for (const k of Object.keys(POLE_CORR)) delete POLE_CORR[k];
  // joint state carried between frames: a stale roll would be applied to the
  // first frame of the next sign before its own hand solve replaces it
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    if (!arm) continue;
    arm.roll = null;
    arm.rollDeg = null;
    arm.upRollDeg = null;
    arm.upRollBleed = 0;
    arm.handTwistDeg = null;
    arm.palmSmoothQ = null;
    arm.wristLow = false;
    arm.prevWristH = null;

    arm.lastPalmQ = null;
    arm.palmBad = 0;
    arm.prevRel = null;
    arm.relSpeedS = null;
    arm.lowerAim = null;
    arm.lastT = null;
    arm.bendDir = null;
    arm.rollTracks = false;
  }
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

function solveArm(side, poseWorld, visOK, handPresent, body = null, dt = 0.016, restW = 0) {
  const arm = ARM[side];
  if (!arm) return;
  const lerp = smoothAlpha(dt, TUNE.tauArm);
  const [iSho, iElb, iWri] = side === "left" ? [11, 13, 15] : [12, 14, 16];
  // a detected hand vouches for the wrist even when pose visibility dips
  if (!visOK(iSho) || (!visOK(iWri) && !handPresent)) {
    // no reliable target: ease back toward rest. Drop the cached target too,
    // or the collision pass would keep re-aiming this arm at a stale pose and
    // fight the easing.
    arm.lastT = null;
    arm.upper.quaternion.slerp(new THREE.Quaternion(), smoothAlpha(dt, 0.2));
    arm.lower.quaternion.slerp(new THREE.Quaternion(), smoothAlpha(dt, 0.2));
    // the roll reference goes with it: rigHand must not decompose the wrist
    // against an aim that no longer describes where this forearm is pointing
    arm.lowerAim = null;
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
  /* Cap the torso axis' OUT-OF-IMAGE tilt. MediaPipe's monocular depth is far
   * weaker than its image-plane tracking, and the hips are its least reliable
   * landmark — on 上樓 the estimated hip depth tilted the whole signer basis
   * 10.4° toward the camera while the signer stood upright in the image. The
   * tilt rotates forward reach into "up": arms crossed 37cm in front of the
   * chest mapped 11cm ABOVE the shoulders and the avatar signed on its face.
   * In-image lean (x/y) is measured reliably and passes through untouched;
   * only the depth component is held to a few degrees. */
  upS.z = clampNum(upS.z, -UP_TILT_MAX_Z, UP_TILT_MAX_Z);
  upS.normalize();
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

  /* the same mapping, for either side's shoulder rather than just this one */
  const mapFrom = (v, shoulderS, shoulderA) => {
    const o = v.clone().sub(shoulderS);
    return shoulderA.clone()
      .add(BODY.right.clone().multiplyScalar((o.dot(rightS) / widthS) * BODY.width))
      .add(BODY.up.clone().multiplyScalar((o.dot(upS) / torsoS) * BODY.torso))
      .add(BODY.fwd.clone().multiplyScalar((o.dot(fwdS) / torsoS) * BODY.torso));
  };

  const S = arm.upper.getWorldPosition(new THREE.Vector3());
  // Smooth the mapped targets, not the bone quaternions: position is a
  // linear space, so an EMA here removes landmark jitter without the
  // rotational lag that smoothing the quaternion introduces.
  // Measured on 辣's static hold: raw wrist landmark moves 0.00374/frame,
  // 0.00195 after this filter — 48% of the visible wander removed. This is
  // the main fix for the arm/wrist drift.
  /* ── keep the two hands' relative geometry ──────────────────────────
   * Solving each arm on its own scales sideways offsets by shoulder width and
   * up/forward offsets by torso length. Those are not the same number: on this
   * rig, measured across six signs, sideways comes out at 0.47 and up/forward
   * at 0.72, because the model's shoulders are narrow for its torso. Every
   * sideways gap between the hands was therefore reproduced a third too small
   * — hands the signer held 20cm apart landed 9.5cm apart instead of 14 — and
   * two-handed signs drove one hand into the other. No amount of pushing the
   * fingers apart afterwards can fix that, because the hands are simply in the
   * wrong place relative to each other.
   *
   * So the PAIR is rebuilt about its own midpoint using a single isotropic
   * scale. Where the pair sits on the body still comes from the per-side
   * mapping, so body-anchored signs stay anchored; only the vector between
   * the hands is restored, and it is restored without distortion. */
  let wristTarget = null;
  if (TUNE.pairGeom && visOK(15) && visOK(16)) {
    const wl = mpToAvatar(poseWorld[15]), wr = mpToAvatar(poseWorld[16]);
    const mid = mapFrom(wl, sgL, BODY.shoulder.left)
      .add(mapFrom(wr, sgR, BODY.shoulder.right))
      .multiplyScalar(0.5);
    const d = wl.sub(wr);
    const iso = BODY.torso / torsoS;
    const dA = BODY.right.clone().multiplyScalar(d.dot(rightS) * iso)
      .add(BODY.up.clone().multiplyScalar(d.dot(upS) * iso))
      .add(BODY.fwd.clone().multiplyScalar(d.dot(fwdS) * iso));
    wristTarget = mid.add(dA.multiplyScalar(side === "left" ? 0.5 : -0.5));
  } else {
    wristTarget = rebuild(bodyRel(wri));   // one wrist unreliable: solve it alone
  }
  const rel = smoothVec(`${side}:wri`, wristTarget.sub(BODY.shoulder[side]), dt, TUNE.tauTarget);
  // The signing clamp holds the arm just short of locked. At rest it has to
  // relax, or it clamps the placed rest target straight back to 0.985 and the
  // elbow keeps its 20 degree bend no matter what the target asked for.
  const maxReach = (arm.L1 + arm.L2) * (0.985 + (REST_REACH - 0.985) * restW);
  // At rest the arm is placed rather than retargeted. Mapping a recorded
  // hanging arm through body-relative coordinates does not give a straight
  // one: the avatar's arms are long for its torso (anime proportions), so a
  // wrist mapped to ~1.1 torso-lengths below the shoulder sits well inside
  // reach and the IK answers with a bent elbow. Aiming at 98.5% of full reach
  // is what makes the arm hang straight, on any model.
  // Measured end to end, the pipeline delivers about 90% of the amplitude the
  // recording had (the forward stroke of 去: 1.195 shoulder-widths in the
  // segment, 1.08 after filtering and resampling), and small strokes read as
  // barely moving. Only the DYNAMIC part is amplified - the deviation from a
  // slow running centre - so a static hold, and therefore any sign that
  // touches the face or chest, still lands exactly where it did. The
  // overshoot is bounded for the same reason.
  const centre = smoothVec(`${side}:centre`, rel, dt, MOVE_TAU);
  const swing = rel.clone().sub(centre).multiplyScalar(TUNE.moveGain - 1);
  if (swing.length() > MOVE_MAX) swing.setLength(MOVE_MAX);
  /* The amplifier only makes sense while the hand is actually TRAVELLING.
   * Its centre is a 0.55s lag, so after a hand rises into a hold the "stroke"
   * it thinks it is enlarging is the leftover of the rise — measured on 上樓
   * the whole hold played 4cm above the recording because of it, and a short
   * dictionary sign never lives long enough for the centre to catch up. Gate
   * the boost by target speed: full mid-stroke, gone within a few frames of
   * settling into a hold — which is exactly when location must be read. */
  const relSpeed = arm.prevRel ? rel.clone().sub(arm.prevRel).length() / Math.max(dt, 1e-3) : 0;
  arm.prevRel = rel.clone();
  arm.relSpeedS = arm.relSpeedS == null ? relSpeed
    : arm.relSpeedS + (relSpeed - arm.relSpeedS) * smoothAlpha(dt, 0.08);
  const boostW = clampNum((arm.relSpeedS - 0.05) / 0.10, 0, 1);
  // Faded out at rest. The running centre lags by MOVE_TAU, so the long
  // travel from the last sign down to the hip reads as a huge "stroke" and
  // the amplifier throws the settled arm another 6cm past its rest pose,
  // then walks it back over half a second. There is no stroke to enlarge in
  // a placed pose, so there is nothing to lose by switching it off.
  rel.add(swing.multiplyScalar((1 - restW) * boostW));
  if (restW > 0) rel.lerp(restReach(side, maxReach), restW);
  if (rel.length() > maxReach) rel.setLength(maxReach);
  // Collision correction is carried as a smoothed, persistent offset rather
  // than applied as an instant fix-up after the fact. Measured: the old
  // post-hoc lerp=1 correction snapped on and off as the hand crossed the
  // collision boundary and multiplied the arm's frame-to-frame jerk by 7.7x
  // on 看 — that was the arm shaking. Folding it into the target means one
  // aim per frame and a correction that ramps instead of popping.
  const corr = CORR[side] || (CORR[side] = new THREE.Vector3());
  /* Where `rel` is measured from, and it differs between the two cases.
   *
   * While SIGNING the target is anchored on the rest shoulder, because sign
   * locations are body-anchored — chin stays chin, chest stays chest — and
   * raising the clavicle must not carry the hand up with it.
   *
   * At REST it is anchored on the live joint instead. The rest pose is a
   * placed direction times a reach, so it only comes out straight if it is
   * measured from the shoulder the arm actually hangs from. Anchoring it on
   * the rest shoulder while the live one moved with the clavicle and chest
   * left the reach slightly wrong and, worse, made the resting arm depend on
   * whatever chest rotation the last sign happened to end on: measured, the
   * same rest pose came out anywhere between 70 and 134 degrees of upper-arm
   * rotation with 17-22 degrees of elbow bend, and the forearm up to 5cm
   * inside the body. Blending the anchor by the rest weight gives each case
   * the frame it needs. */
  const anchor = BODY.shoulder[side].clone().lerp(S, restW);
  const T = anchor.add(rel).add(corr);
  const reach = T.clone().sub(S);
  if (reach.length() > maxReach) T.copy(S).add(reach.setLength(maxReach));

  // Elbow offset uses the same origin as the wrist above. The original
  // subtracted the LIVE shoulder S from a point rebuilt around the REST
  // shoulder, so any chest rotation leaked (BODY.shoulder − S) into the
  // pole vector and swung the elbow — visible as the shoulder/arm wander.
  const pole = smoothVec(`${side}:elb`, rebuild(bodyRel(elb)).sub(BODY.shoulder[side]), dt, TUNE.tauTarget);
  if (restW > 0) pole.lerp(restPole(side, maxReach * 0.5), restW);
  const pc = POLE_CORR[side];
  if (pc) pole.add(pc);   // swing the elbow clear of the torso

  arm.lastS = S.clone();
  arm.lastT = T.clone();
  arm.lastPole = pole.clone();
  aimArm(side, S, T, pole, lerp, dt, restW);
}

/* ── rest posture ────────────────────────────────────────────────────
 * Where the hand sits when the arm hangs. Built in the AVATAR's own body
 * frame, not mapped from a recording, so it is straight and clear of the body
 * whatever the signer or the model.
 *
 * The outward component sets how far the arms hang from the body. It was 0.36,
 * which is 20.7 degrees of abduction — a relaxed human arm hangs at 5 to 10,
 * and the difference is what made the shoulders look broad and sloped. 0.27 is
 * about 16 degrees: still above a bare arm's resting angle, but this model
 * wears an oversized cardigan, and at 11 degrees the forearm sat 2cm inside
 * the coat. Sixteen is the smallest angle measured to actually clear it. Nothing bigger is needed, because the collision pass is faded
 * out at rest (see updateCollisionCorrections): the rest pose is placed rather
 * than solved, so it is known-good by construction and does not need to be
 * pushed off a body volume that was deliberately fitted wide enough to cover
 * the cardigan. Leaving the push active is what previously forced the arms
 * back out however narrow this was set. */
const REST_OUT = 0.27;    // sideways, as a fraction of the down component
const REST_FWD = 0.10;    // a little in front of the hip, as a real arm hangs
/* Reach fraction for the rest pose. The signing clamp of 0.985 is not enough
 * to look straight: at that distance the law of cosines still puts the elbow
 * 4cm off the shoulder-wrist line, which measured as a 20 degree bend. 0.997
 * brings it to about 9, which reads as a hanging arm without locking it. */
const REST_REACH = 0.997;
/* How much of the pole has to be perpendicular to the arm before it is
 * believed: 0.15 is about 8.6 degrees off the arm axis. */
const POLE_MIN_FRACTION = 0.15;
const TAU_BEND = 0.09;          // how fast the elbow plane may turn
const ROLL_TRACK_ENTER = 0.975; // start solving humeral roll below this
const ROLL_TRACK_LEAVE = 0.990; // and stop only above this

function restReach(side, reach) {
  const out = BODY.right.clone().multiplyScalar(side === "left" ? -1 : 1);
  return BODY.up.clone().multiplyScalar(-1)
    .add(out.multiplyScalar(REST_OUT))
    .add(BODY.front.clone().multiplyScalar(REST_FWD))
    .normalize()
    .multiplyScalar(reach);
}

/* ── the elbow plane at rest ─────────────────────────────────────────
 * THE END-OF-SENTENCE TREMOR LIVED HERE.
 *
 * The rest pole used to be restReach() again at half length — the same
 * direction as the wrist target. A pole parallel to shoulder→wrist carries
 * no plane: aimArm projects the arm direction out of it and is left with
 * whatever rounding noise survives, then places the elbow 1.5cm off the
 * line in that arbitrary direction. Different noise next frame, different
 * elbow, and both arms shook. It appeared as the sentence ended because
 * that is exactly when the rest weight ramps up and the pole slides into
 * being parallel.
 *
 * A hanging arm has its olecranon pointing backwards and a little out, so
 * that is what this says — and it is never parallel to the hang direction,
 * so the plane is always well defined. */
const REST_POLE_BACK = 0.55;   // behind the hang line: where a real elbow points
const REST_POLE_OUT = 0.30;    // and slightly away from the ribs

function restPole(side, reach) {
  const out = BODY.right.clone().multiplyScalar(side === "left" ? -1 : 1);
  return BODY.up.clone().multiplyScalar(-1)
    .add(BODY.front.clone().multiplyScalar(-REST_POLE_BACK))
    .add(out.multiplyScalar(REST_POLE_OUT))
    .normalize()
    .multiplyScalar(reach);
}

/* two-bone IK: place the elbow by law of cosines, steered by the pole hint,
 * then aim upper and lower arm. Split out of solveArm so the hand-collision
 * pass can re-run it against a corrected wrist target. */
function aimArm(side, S, T, pole, lerp, dt, restW = 0) {
  const arm = ARM[side];
  const d = T.clone().sub(S);
  const dl = Math.max(d.length(), 1e-4);
  const dirn = d.clone().divideScalar(dl);
  const a = Math.min(Math.max((arm.L1 ** 2 - arm.L2 ** 2 + dl ** 2) / (2 * dl), -arm.L1), arm.L1);
  const h = Math.sqrt(Math.max(arm.L1 ** 2 - a * a, 0));
  // Which way the elbow leaves the shoulder→wrist line. Two guards, because
  // an ill-conditioned answer here is a visible tremor (see restPole):
  //
  //  - the test is RELATIVE. A pole 99% parallel to the arm defines no plane
  //    however long it is, and the old absolute 1e-6 let that through: the
  //    perpendicular component was still 1e-3, comfortably above the floor
  //    and made almost entirely of rounding error.
  //  - and the plane is CARRIED. When this frame's pole says nothing useful,
  //    the arm keeps the plane it was already bending in rather than picking
  //    a fresh one out of the noise, and even a well-defined plane is eased
  //    into rather than snapped to.
  const poleLen = Math.max(pole.length(), 1e-6);
  let m = pole.clone().sub(dirn.clone().multiplyScalar(pole.dot(dirn)));
  if (m.length() >= POLE_MIN_FRACTION * poleLen) {
    m.normalize();
    arm.bendDir = arm.bendDir
      ? arm.bendDir.lerp(m, smoothAlpha(dt, TAU_BEND)).normalize()
      : m.clone();
  } else if (!arm.bendDir) {
    arm.bendDir = BODY.front.clone().negate();   // elbows back, as an arm hangs
  }
  m = arm.bendDir.clone().sub(dirn.clone().multiplyScalar(arm.bendDir.dot(dirn)));
  if (m.lengthSq() < 1e-9) m.set(0, -1, 0.2);   // truly degenerate: elbow drops down
  m.normalize();
  const elbowPos = S.clone().add(dirn.clone().multiplyScalar(a)).add(m.multiplyScalar(h));

  // ── upper arm: aim, then roll so the elbow creases the right way ──
  // The IK fixes where the elbow IS; nothing fixed which way it BENDS. A
  // minimal-arc aim leaves the humerus' roll arbitrary, so the forearm could
  // leave the elbow sideways or backwards — the joint reads as dislocated and
  // the deltoid skinning twists with it. Rolling the humerus until its
  // captured "front" reference lies in the actual arm plane is what a real
  // shoulder does: internal/external rotation sets the plane the elbow folds
  // in, and the elbow itself is a hinge.
  const upperAim = aimLocal(arm.upper, arm.restDirUpper, arm.restQUpper,
    elbowPos.clone().sub(S).normalize());
  const uAxis = elbowPos.clone().sub(S).normalize();
  const bend = orthonormal(T.clone().sub(elbowPos), uAxis);
  const upParentQ = arm.upper.parent.getWorldQuaternion(new THREE.Quaternion());
  const ref = arm.bendUpper.clone()
    .applyQuaternion(upParentQ.clone().multiply(upperAim));
  // Near-straight arms have no bend plane to speak of, and forcing one there
  // would spin the whole arm on noise. Measured elbow flexion runs 82–134°, so
  // this guard almost never fires — it is there for the transitions.
  // Same branch-cut hazard as the forearm, and worse consequences: a wrap here
  // spins the whole arm about the humerus. Tracked as a continuous angle.
  // Hysteresis, not a single threshold: an arm straightening through 0.985
  // flickered the roll solve on and off from frame to frame, and each switch
  // is a different humeral rotation.
  const straightness = T.clone().sub(elbowPos).normalize().dot(dirn);
  arm.rollTracks = arm.rollTracks
    ? straightness < ROLL_TRACK_LEAVE
    : straightness < ROLL_TRACK_ENTER;
  if (arm.rollTracks) {
    trackRoll(arm, "upRollDeg",
      signedAngle(orthonormal(ref, uAxis), bend, uAxis) * 180 / Math.PI,
      dt, UPPER_ROLL_DEG, UPPER_ROLL_RATE);
  }
  // A hanging arm is straight, so the guard above stops updating: without this
  // it would keep the last sign's humeral rotation and the resting arm would
  // look twisted differently every time. Anatomically the resting humerus sits
  // near mid-rotation between internal and external, so it unwinds to zero.
  if (restW > 0 && arm.upRollDeg) {
    arm.upRollDeg *= 1 - smoothAlpha(dt, 0.15) * restW;
  }
  // the shoulder's own rotation, plus whatever pronation it is carrying for
  // the forearm (see FOREARM_TWIST_SOFT). Applied here rather than in rigHand
  // because the forearm is re-aimed at the wrist target below, so this can
  // never move the hand — only redistribute the twist along the arm.
  const upRoll = (arm.upRollDeg || 0) + (arm.upRollBleed || 0);
  const upperTarget = upRoll
    ? upperAim.multiply(rollQuat(arm.axisUpper, upRoll * Math.PI / 180))
    : upperAim;
  arm.upper.quaternion.slerp(upperTarget, lerp);
  arm.upper.updateWorldMatrix(true, true);

  // ── forearm: aim, then apply the pronation the wrist solve asked for ──
  // arm.roll is recomputed from scratch every frame in rigHand, against this
  // roll-free aim. Keeping the aim as the reference is the whole point: the
  // old code multiplied the roll onto the forearm's CURRENT rotation, which
  // integrated (and fought this aim, which kept undoing it), so the twist ran
  // away — 717° on 玩, where no absolute solve can exceed 180°.
  const lowerAim = aimLocal(arm.lower, arm.restDirLower, arm.restQLower,
    T.clone().sub(arm.lower.getWorldPosition(new THREE.Vector3())).normalize());
  /* NOTE (tried and reverted): stripping this aim's axial twist and letting
   * rollDeg carry everything looks attractive — the aim's parasitic twist is
   * what sweeps a lowering arm's forearm — but it is WRONG: the parasitic
   * component changes as fast as the arm moves, and pushing it through the
   * rate-limited, branch-tracked rollDeg path lagged the palm everywhere
   * (mean palm error 13°→62°). The parasitic twist must stay on the
   * instantaneous path; garbage input is handled at the SOURCE instead
   * (wristLow / drop-from-peak / palm-rate gates → relax). */
  arm.lowerAim = lowerAim.clone();
  arm.lower.quaternion.slerp(arm.roll ? lowerAim.multiply(arm.roll) : lowerAim, lerp);
  arm.lower.updateWorldMatrix(true, true);
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
/* The pole correction gets its own, larger budget. It only swings the elbow
 * around the shoulder→wrist axis: the hand stays exactly where the sign put
 * it and the handshape is untouched, so unlike CORR it cannot distort the
 * sign — it can only choose a different elbow. Sharing CORR's 7cm cap was
 * leaving the arm stuck in the chest with the correction already saturated. */
const POLE_MAX = 0.09;    // metres
const ARM_SAMPLES = 4;    // per segment
const UPPER_FROM = 0.45;  // skip the humeral head, it belongs inside the shoulder
const WRIST_TO = 0.85;    // the hand probes own the last stretch

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

/* The finger bones as segments: every joint-to-joint span, plus two spans
 * across the palm. Rebuilt per frame from the live bone positions. */
const HAND_SEGMENTS = [];

function captureHandSegments() {
  HAND_SEGMENTS.length = 0;
  for (const [finger, segs] of Object.entries(FINGER_CHAINS))
    for (let i = 0; i < segs.length - 1; i++)
      HAND_SEGMENTS.push([`${finger}${segs[i]}`, `${finger}${segs[i + 1]}`]);
  HAND_SEGMENTS.push(["Hand", "IndexProximal"], ["Hand", "LittleProximal"]);
}

function handSegments(side) {
  const out = [];
  for (const [a, b] of HAND_SEGMENTS) {
    const p = bonePos(`${side}${a}`, new THREE.Vector3());
    const q = bonePos(`${side}${b}`, new THREE.Vector3());
    if (p && q) out.push([p.clone(), q.clone()]);
  }
  return out;
}

/* Closest approach between two segments; `dir` runs from the point on the
 * first to the point on the second. Standard clamped-parameter solve. */
function closestBetweenSegments(p1, q1, p2, q2) {
  const d1 = q1.clone().sub(p1), d2 = q2.clone().sub(p2), r = p1.clone().sub(p2);
  const a = d1.dot(d1), e = d2.dot(d2), f = d2.dot(r);
  const EPS = 1e-9;
  let s, t;
  if (a <= EPS && e <= EPS) {
    s = t = 0;
  } else if (a <= EPS) {
    s = 0;
    t = Math.min(1, Math.max(0, f / e));
  } else {
    const c = d1.dot(r);
    if (e <= EPS) {
      t = 0;
      s = Math.min(1, Math.max(0, -c / a));
    } else {
      const b = d1.dot(d2);
      const denom = a * e - b * b;
      s = denom > EPS ? Math.min(1, Math.max(0, (b * f - c * e) / denom)) : 0;
      t = (b * s + f) / e;
      if (t < 0) { t = 0; s = Math.min(1, Math.max(0, -c / a)); }
      else if (t > 1) { t = 1; s = Math.min(1, Math.max(0, (b - c) / a)); }
    }
  }
  const c1 = p1.clone().add(d1.multiplyScalar(s));
  const c2 = p2.clone().add(d2.multiplyScalar(t));
  return { d: c1.distanceTo(c2), dir: c2.sub(c1) };
}

/* One pass for every contact constraint. Each side accumulates a desired
 * offset, which is then eased into CORR so the arm never jumps. */
function updateCollisionCorrections(dt, restW = 0) {
  if (!TUNE.collide) { for (const k of Object.keys(CORR)) CORR[k].set(0, 0, 0);
    for (const k of Object.keys(POLE_CORR)) POLE_CORR[k].set(0, 0, 0); return; }
  const alpha = smoothAlpha(dt, TAU_CORR);
  const active = 1 - Math.min(1, Math.max(0, restW));
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

  // 2. arm segments vs body. The hand probes above cannot fix these: the elbow
  // is placed by the pole vector, so an arm lying against the torso needs the
  // ELBOW swung out, not the wrist moved. Both segments are sampled, each
  // carrying its own measured thickness.
  //
  // The upper arm was not tested at all before, and it is the segment that was
  // actually inside the body: measured across 14 signs its centreline sat
  // 0–1cm INSIDE the torso surface from the shoulder to mid-humerus in the
  // MEDIAN frame, on both sides. The forearm was mostly clear of the surface,
  // but not clear of it by a forearm's radius.
  //
  // Sampling starts partway down the humerus on purpose: the humeral head
  // genuinely lives inside the shoulder mass — it is a ball joint buried in
  // the deltoid — so demanding clearance there would fight the model's own
  // anatomy and hold the arms out permanently.
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    const pc = POLE_CORR[side] || (POLE_CORR[side] = new THREE.Vector3());
    if (!arm || !arm.lastT) { pc.multiplyScalar(1 - alpha); continue; }
    const s = arm.upper.getWorldPosition(new THREE.Vector3());
    const e = arm.lower.getWorldPosition(new THREE.Vector3());
    const w = arm.hand.getWorldPosition(new THREE.Vector3());
    const sum = new THREE.Vector3();
    let hits = 0;
    for (const [a, b, u0, u1, r, taper] of [
      [s, e, UPPER_FROM, 1, LIMB.upper, true],
      [e, w, 0, WRIST_TO, LIMB.lower, false],  // wrist end left to the hand probes
    ]) {
      for (let k = 0; k <= ARM_SAMPLES; k++) {
        const f = k / ARM_SAMPLES;
        const q = a.clone().lerp(b, u0 + (u1 - u0) * f);
        // The humerus does not have a constant thickness as far as the body is
        // concerned: its head is a ball joint buried in the deltoid, and the
        // deltoid merges into the torso. Demanding a full arm radius up there
        // asks for clearance the anatomy cannot give — measured, the top
        // sample was violated on 28% of frames while the elbow end was never
        // violated at all, so the correction never converged, wound up to its
        // cap on 29% of frames, and held the elbows 15cm out to the sides.
        // That splay was the "dislocated shoulder". Ramping the requirement
        // from nothing at the shoulder to the full radius at the elbow makes
        // the constraint satisfiable, so it releases when it should.
        const out = pushOutOfBody(q, taper ? r * f * f * (3 - 2 * f) : r);
        const d = out.distanceTo(q);
        if (d > 1e-5) { sum.add(out.sub(q)); hits++; }
      }
    }
    const wantPole = hits
      ? pc.clone().add(sum.divideScalar(hits).multiplyScalar(CORR_GAIN))
      : new THREE.Vector3();
    pc.lerp(wantPole.multiplyScalar(active), alpha);
    if (pc.length() > POLE_MAX) pc.setLength(POLE_MAX);
  }

  // 3. hand vs hand, as CAPSULES rather than points.
  //
  // The previous test compared joint positions, and a finger is not a point:
  // two fingers can cross at their midpoints while every pair of joints stays
  // comfortably apart, so the test saw nothing and the hands passed through
  // each other. That is why per-joint separation plateaued around 1.5-1.6cm
  // however hard it pushed — it was converging on the wrong quantity.
  //
  // Measured over 18 signs with the segment test: 6 had finger segments
  // within 18mm and several sat at zero to four decimal places (會 0.0000,
  // 吃 and 學校 0.0001, 日本 and 家 0.0013) — the bones genuinely intersected.
  // Comparing bone SEGMENTS finds those.
  //
  // Only the deepest violation drives the push, and the two hands share it
  // symmetrically so neither is singled out.
  if (ARM.left.lastT && ARM.right.lastT) {
    const L = handSegments("left"), R = handSegments("right");
    const min = FINGER_R * 2;
    let worst = null, overlap = 0;
    for (const a of L) for (const b of R) {
      const hit = closestBetweenSegments(a[0], a[1], b[0], b[1]);
      if (hit.d < min && min - hit.d > overlap) {
        overlap = min - hit.d;
        worst = hit.d > 1e-5 ? hit.dir.clone().normalize() : new THREE.Vector3(1, 0, 0);
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
    corr.lerp(want[side].multiplyScalar(active), alpha);
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
const FINGER_MAX_DEG = 100;   // backstop only; the per-joint ROM below is what binds

/* ── anatomical joint model ──────────────────────────────────────────
 * Aiming every finger bone freely along its measured direction gives each
 * joint three degrees of freedom. A real finger has far fewer: PIP and DIP
 * are hinges with one axis, and only the knuckle can spread. The two extra
 * degrees were being filled with whatever MediaPipe's depth noise happened to
 * say, and that is what let the fingers cross into each other — measured over
 * eleven sentences, adjacent phalanges came within 6mm of centreline (they
 * cannot come closer than about 11mm on this rig without intersecting) in
 * 28.4% of frames.
 *
 * So each joint is solved in its own anatomy: a flexion angle about the
 * finger's own hinge axis, plus an abduction angle at the knuckle only, each
 * held inside the ranges the hand-kinematics literature gives (MCP flexion
 * 0-90 with a little hyperextension, ±20 spread; PIP 0-110; DIP 0-80 — the
 * Lin/Wu/Huang constraint set used in hand tracking, matching the clinical
 * ranges). What cannot be represented anatomically is dropped rather than
 * turned into a sideways deviation no finger has. */
const JOINT_ROM = {
  //                    flexMin flexMax  abdMax (null = pure hinge)
  fingerMCP: { min: -20, max: 90, abd: 20 },
  fingerPIP: { min: -5, max: 110, abd: null },
  fingerDIP: { min: -10, max: 80, abd: null },
  thumbCMC: { min: -35, max: 60, abd: 45 },
  thumbMCP: { min: -10, max: 60, abd: 12 },
  thumbIP: { min: -15, max: 80, abd: null },
};
const ROM_FOR = {
  Thumb: [JOINT_ROM.thumbCMC, JOINT_ROM.thumbMCP, JOINT_ROM.thumbIP],
  other: [JOINT_ROM.fingerMCP, JOINT_ROM.fingerPIP, JOINT_ROM.fingerDIP],
};
/* DIP and PIP share a tendon, so they cannot be set independently: a straight
 * PIP with a fully folded DIP is not a shape a hand can hold. Rather than force
 * the textbook 2/3 ratio (which would flatten handshapes that really do differ),
 * the DIP is only kept inside a band around what the PIP is doing. */
const DIP_BAND = { lo: 0.35, hi: 1.15, slack: 22 };
/* hinge auto-calibration: how bent the joint must be before its lean is
 * evidence about the axis, how fast the estimate moves, and how far it may
 * stray from the rest pose's answer */
const HINGE_CAL_MIN_SIN = 0.42;   // ≈25 degrees of bend
const HINGE_CAL_ALPHA = 0.02;     // ~1.6 s time constant at 30 fps
const HINGE_CAL_MAX = 35;         // degrees
const FINGER_REST = {};
/* per side: +1 if the palm-basis normal already points palmar, -1 if it points
 * dorsal — resolved once at capture from where the thumb column sits */
const PALMAR_SIGN = { left: 1, right: 1 };

/* the flexion axis of one finger, in world space at rest: whichever adjacent
 * pair of phalanges is most clearly bent defines it, since a finger only bends
 * one way. `palmar` is the side that counts as flexion. */
/* One flexion axis for the whole finger, oriented once.
 *
 * The axis and its SIGN are decided at the finger level, never per joint. The
 * first version flipped any joint whose rest angle came out negative, which
 * made hinges inside one finger point opposite ways (measured: ThumbDistal,
 * RingIntermediate and LittleIntermediate all at dot = −1 to their own
 * knuckle) — so a recorded 90° bend folded that phalanx 90° BACKWARD, the
 * zig-zag "twisted claw". A slightly negative rest angle is fine; a flipped
 * axis is not.
 *
 * Direction comes from the finger's own rest curl when it has one (summed
 * cross products — the thumb's is strong), and otherwise from the palm frame
 * the way the ISB hand convention defines it: flexion axis = palmar normal ×
 * finger direction, so positive flexion always curls toward the palm. */
function fingerFlexAxis(dirs, palmarN) {
  const sum = new THREE.Vector3();
  for (let i = 0; i + 1 < dirs.length; i++)
    sum.add(new THREE.Vector3().crossVectors(dirs[i], dirs[i + 1]));
  const fromPalm = palmarN && dirs[0]
    ? new THREE.Vector3().crossVectors(palmarN, dirs[0]) : null;
  // 0.25 ≈ 15° of genuine rest curl. Below that the cross-products are the
  // modeling noise of a flat hand and must not out-vote the palm frame —
  // trusting them at 0.08 is what flipped this model's fingers.
  if (sum.length() > 0.25) {
    const axis = sum.clone().normalize();
    if (fromPalm && fromPalm.lengthSq() > 1e-6 && axis.dot(fromPalm) < 0) axis.negate();
    return axis;
  }
  return fromPalm && fromPalm.lengthSq() > 1e-6 ? fromPalm.normalize() : null;
}

/* Signed angle between a finger's proximal phalanx and the middle finger's,
 * about the palm normal: the spread, measured without reference to anything
 * outside the hand it was measured on. */
function spreadAgainstMiddle(side, dir, palm, ref) {
  if (!dir || !palm) return 0;
  const n = new THREE.Vector3().setFromMatrixColumn(palm, 1).normalize();
  const mid = ref || (() => {
    const a = vrm.humanoid.getNormalizedBoneNode(`${side}MiddleProximal`);
    const b = vrm.humanoid.getNormalizedBoneNode(`${side}MiddleIntermediate`);
    if (!a || !b) return null;
    return b.getWorldPosition(new THREE.Vector3()).sub(a.getWorldPosition(new THREE.Vector3())).normalize();
  })();
  if (!mid) return 0;
  const flat = v => { const o = v.clone(); o.addScaledVector(n, -o.dot(n)); return o.lengthSq() > 1e-10 ? o.normalize() : null; };
  const a = flat(mid), b = flat(dir);
  if (!a || !b) return 0;
  return Math.atan2(new THREE.Vector3().crossVectors(a, b).dot(n), a.dot(b)) * 180 / Math.PI;
}

function captureFingerRest() {
  captureHandSegments();
  for (const k of Object.keys(FINGER_REST)) delete FINGER_REST[k];
  HAND_PROBES.length = 1;   // keep "Hand", then every finger joint
  for (const [finger, segs] of Object.entries(FINGER_CHAINS))
    for (const s of segs) HAND_PROBES.push(`${finger}${s}`);
  for (const side of ["left", "right"]) {
    /* The palmar normal, signed so it points out of the PALM side (the side
     * the fingers curl toward).
     *
     * The sign CANNOT come from the model's rest-pose finger curl: this rig's
     * bind pose is a flat hand — per-finger curl cross-products are 0.05-0.08
     * (noise scale) with mixed signs, so a majority vote is a coin flip, and
     * it landed wrong: every finger bent 70-90 degrees BACKWARD, the flat
     * splayed "deformed hand".
     *
     * What is invariantly on the palm side of the hand plane, flat hand or
     * not, is the THUMB COLUMN — measured on this rig its proximal/distal
     * joints sit 0.64-0.79 palm-widths off the plane, opposite signs on the
     * two hands, exactly as anatomy says. So the thumb decides. */
    let palmarN = null, palmarSign = 1;
    const arm = ARM[side];
    if (arm && arm.restPalm) {
      palmarN = new THREE.Vector3().setFromMatrixColumn(arm.restPalm, 1).normalize();
      const wristP = vrm.humanoid.getNormalizedBoneNode(`${side}Hand`)
        .getWorldPosition(new THREE.Vector3());
      let off = 0, cnt = 0;
      for (const tname of ["ThumbProximal", "ThumbDistal"]) {
        const tb = vrm.humanoid.getNormalizedBoneNode(`${side}${tname}`);
        if (!tb) continue;
        off += tb.getWorldPosition(new THREE.Vector3()).sub(wristP).dot(palmarN);
        cnt++;
      }
      if (cnt && off < 0) { palmarSign = -1; palmarN.negate(); }
      PALMAR_SIGN[side] = palmarSign;
    }
    for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
      const bones = [], dirs = [], parentQs = [];
      for (let i = 0; i < segs.length; i++) {
        const name = `${side}${finger}${segs[i]}`;
        const bone = vrm.humanoid.getNormalizedBoneNode(name);
        if (!bone) { bones.push(null); dirs.push(null); parentQs.push(null); continue; }
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
        const dir = tip ? tip.sub(p) : null;
        bones.push(bone);
        dirs.push(dir && dir.lengthSq() > 1e-10 ? dir.normalize() : null);
        parentQs.push(bone.parent.getWorldQuaternion(new THREE.Quaternion()));
      }
      const axisWorld = fingerFlexAxis(dirs.filter(Boolean), palmarN);
      /* Self-check the convention instead of trusting it: rotating the first
       * phalanx +20° about the chosen axis must carry its tip toward the palm
       * side. A silent sign error here bends every recorded angle backward, so
       * a failure is corrected AND shouted about. */
      if (axisWorld && palmarN && dirs[0]) {
        const probe = dirs[0].clone()
          .applyQuaternion(new THREE.Quaternion().setFromAxisAngle(axisWorld, 0.35));
        if (probe.sub(dirs[0]).dot(palmarN) < 0) {
          console.warn(`[avatar3d] ${side}${finger}: flexion axis pointed dorsal — flipped`);
          axisWorld.negate();
        }
      }
      // how far this finger already sits from the middle one in the rest pose
      const restSpread = spreadAgainstMiddle(side, dirs[0], arm && arm.restPalm);
      for (let i = 0; i < segs.length; i++) {
        const name = `${side}${finger}${segs[i]}`;
        if (!bones[i] || !dirs[i] || !axisWorld) continue;
        // Stored in the PARENT's rest frame, not in world. The bone's local
        // rotation is expressed against its parent, so keeping the reference
        // there is what makes the solve independent of how the hand as a whole
        // is oriented (see solveFingerJoint). The hinge axis lives in the same
        // frame: along a hinge chain it is the one direction every joint shares,
        // so expressing it per parent costs nothing and stays exact.
        const inv = parentQs[i].clone().invert();
        const t = dirs[i].clone().applyQuaternion(inv).normalize();
        const k = axisWorld.clone().applyQuaternion(inv).normalize();
        // make the hinge exactly perpendicular to the bone, then the palmar
        // normal completes a right-handed frame: +flexion tips t toward n
        k.sub(t.clone().multiplyScalar(k.dot(t)));
        if (k.lengthSq() < 1e-8) continue;
        k.normalize();
        const n = new THREE.Vector3().crossVectors(k, t).normalize();
        /* Spread is MEASURED about the raw palm-basis normal (recording and
         * rest alike) but APPLIED about this joint's own n = k×t, and the
         * chirality between those two flips with the palmar sign. Determined
         * empirically here — rotating about n must increase the measured
         * angle — and stored, because getting this sign wrong pins every
         * knuckle at its abduction limit. */
        const nWorld = n.clone().applyQuaternion(parentQs[i]);
        const nRaw = palmarN ? palmarN.clone().multiplyScalar(PALMAR_SIGN[side]) : null;
        const spreadSign = nRaw && nWorld.dot(nRaw) < 0 ? -1 : 1;
        /* the parent phalanx's own direction, in the same frame: this bone
         * hangs off the end of it, so its local position IS that direction.
         * phi0 is where the model's rest pose already sits on the hinge and
         * pPerp how much of the parent survives the projection — together they
         * invert "bend this joint to N degrees" in closed form. */
        const par = bones[i].position.lengthSq() > 1e-12
          ? bones[i].position.clone().normalize() : t.clone();
        const pk = par.dot(k);
        const perp = par.clone().addScaledVector(k, -pk);
        const pPerp = Math.max(perp.length(), 1e-3);
        perp.divideScalar(pPerp);
        const phi0 = Math.atan2(new THREE.Vector3().crossVectors(perp, t).dot(k), perp.dot(t)) * 180 / Math.PI;
        // phi0 may legitimately be a little negative (a joint modeled a touch
        // hyperextended). It must NOT be "fixed" by flipping this joint's axis:
        // the axis convention belongs to the finger, and flipping one joint
        // sends its whole recorded bend the wrong way.
        FINGER_REST[name] = {
          dir: dirs[i].clone(),
          dirLocal: t,
          flex: k,
          palmar: n,
          rom: (ROM_FOR[finger] || ROM_FOR.other)[i],
          joint: i,
          finger,
          phi0,
          pPerp,
          restSpread,
          spreadSign,
          restBend: Math.acos(clampNum(par.dot(t), -1, 1)) * 180 / Math.PI,
        };
      }
    }
  }
}

/* Solve one finger joint inside its own anatomy.
 *
 * Three things here are deliberate, and the first two were bugs before.
 *
 * 1. The solve happens in the PARENT's local frame. The old version built a
 *    minimal-arc rotation from a world rest direction to a world target, then
 *    rebased it. A minimal arc carries a parasitic roll that depends on the
 *    target's direction, and that roll does NOT cancel against the parent — so
 *    whenever the wrist turned, every finger picked up rotation that had
 *    nothing to do with the recorded handshape.
 *
 * 2. The joint is solved as ANGLES, not as a quaternion that is clamped
 *    afterwards. Clamping a blended quaternion bounds nothing: slerp does not
 *    interpolate rotation MAGNITUDE, and two rotations of the same size about
 *    opposing axes interpolate through a much larger one (measured: 99° about
 *    +X blended 36% toward 100° about −X gives 156.9°, and a joint bent 156°
 *    inverts the skinning — the black gaps at the knuckles). Smoothing the
 *    flexion and abduction angles instead cannot leave the range at all.
 *
 * 3. Only the degrees of freedom the joint has are kept. The measured
 *    direction is resolved into flexion about the finger's hinge axis and
 *    abduction across the palm; everything else — the sideways deviation of a
 *    hinge, the axial roll of a phalanx — is discarded rather than reproduced,
 *    because it is tracking noise, and following it is what drove neighbouring
 *    fingers through each other. */
const FINGER_STATE = {};   // per bone: smoothed flexion / abduction, in degrees
const FINGER_DEBUG = { on: false, rows: [] };

/* Solve one joint to the angle the recording's own joint is bent to.
 *
 * What is matched is the ANGLE BETWEEN THE TWO PHALANGES, not the direction
 * the bone points. That distinction is the whole point: the signer's hand and
 * the model's hand are different shapes, so aiming each avatar bone along the
 * signer's measured bone direction reproduces the signer's hand geometry on a
 * skeleton that does not have it, and the joint ends up bent by a different
 * amount than the recording. How far a joint is bent is what the handshape IS,
 * so that is what is transferred. It is also measured entirely inside the
 * recording, which makes it immune to any error in the palm alignment.
 *
 * The joint then has only the freedom its anatomy gives it: flexion about the
 * finger's hinge, plus spread at the knuckle. Solving for the flexion is
 * closed-form — the bone stays in the plane perpendicular to the hinge, so the
 * angle to the parent varies as cos(phi0 + theta) and inverts directly. */
function solveFingerJoint(name, bone, rest, spreadDeg, bendDeg, alpha, pipFlex) {
  const rom = rest.rom;
  const st = FINGER_STATE[name] || (FINGER_STATE[name] = { flex: 0, abd: 0 });
  const k = rest.flex, n = rest.palmar, t = rest.dirLocal;

  /* Spread, which only the knuckle has. Measured the same way as the bend —
   * inside the recording, as the angle this finger makes with the middle one —
   * and then applied as the DIFFERENCE from the model's own rest spread. Taking
   * it from the mapped direction instead makes it carry every error in the palm
   * alignment, and measured that pinned the index knuckle at its ±20° limit. */
  const abd = rom.abd == null ? 0
    : clampNum((spreadDeg == null ? 0 : (spreadDeg - rest.restSpread) * (rest.spreadSign || 1)),
        -rom.abd, rom.abd);

  /* flexion: whatever bends this joint to the angle the recording holds */
  let want = clampNum(bendDeg, 0, rom.max + Math.max(0, rest.restBend));
  want = contrastFlex(want, rom);
  if (TUNE.dipBand && rest.joint === 2 && pipFlex != null && rom.abd == null) {
    want = clampNum(want, pipFlex * DIP_BAND.lo - DIP_BAND.slack, pipFlex * DIP_BAND.hi + DIP_BAND.slack);
  }
  const reach = Math.acos(clampNum(Math.cos(want * Math.PI / 180) / rest.pPerp, -1, 1)) * 180 / Math.PI;
  const flex = clampNum(reach - rest.phi0, rom.min, rom.max);

  st.flex += (flex - st.flex) * alpha;
  st.abd += (abd - st.abd) * alpha;
  applyFingerState(bone, rest, st);
  if (FINGER_DEBUG.on) FINGER_DEBUG.rows.push({ name, bendDeg: +bendDeg.toFixed(1), want: +want.toFixed(1),
    flex: +flex.toFixed(1), st: +st.flex.toFixed(1), phi0: +rest.phi0.toFixed(1),
    pPerp: +rest.pPerp.toFixed(3), restBend: +rest.restBend.toFixed(1), abd: +abd.toFixed(1) });
  return st.flex + rest.restBend;   // the joint's realised bend, for the DIP band
}

/* rebuild a joint's local rotation from its two angles: flexion about the
 * hinge, then abduction across the palm. No third component exists, so no
 * parasitic roll can reach the children. */
function applyFingerState(bone, rest, st) {
  const q = new THREE.Quaternion().setFromAxisAngle(st.axis || rest.flex, st.flex * Math.PI / 180);
  if (st.abd) q.premultiply(new THREE.Quaternion().setFromAxisAngle(st.normal || rest.palmar, st.abd * Math.PI / 180));
  bone.quaternion.copy(q);
  bone.updateWorldMatrix(true, true);
}

/* ── handshape contrast ──────────────────────────────────────────────
 * A handshape inventory is BIMODAL: a finger is either extended or it is
 * curled, and which fingers are which is what distinguishes one sign from
 * the next. Measured over 15 signs the retarget produced neither — 7.1% of
 * joint angles below 10°, 2.6% above 80°, and 54% piled into 10–40°. The
 * index finger of a "1" hand sat at 31° and the ring at 53°, so every
 * handshape came out as the same vague half-closed fist. That is why the
 * signs were hard to read even though the arms were going to the right
 * places.
 *
 * The loss is inherent to the retarget rather than to any one step: MediaPipe
 * under-flexes fingers it sees at an angle, the offline filter takes a little
 * more, and the avatar's own rest pose is already slightly curled, so "no
 * bend" never maps to a straight finger. Rather than chase each, the flexion
 * angle is pushed back toward whichever end of its range it is nearer, which
 * restores the contrast without inventing a handshape: the ORDER of the joints
 * is untouched, only the spacing. A pure gain would not do — it would drive the
 * near-extended fingers further closed, which is the wrong way. */
function contrastFlex(deg, rom) {
  const gain = TUNE.fingerContrast;
  if (!(deg > 0) || !(rom.max > 0) || !gain) return deg;
  const x = Math.min(1, deg / rom.max);
  const sm = x * x * (3 - 2 * x);                // smoothstep: pushes to the ends
  return (x + gain * (sm - x)) * rom.max;
}

/* ── neighbouring fingers must not share the same space ──────────────
 * The anatomy above stops a finger deviating sideways into its neighbour, but
 * two fingers can still be aimed at the same place — a fist closes them onto
 * one another, and the recording's own depth noise decides which. This is the
 * standard fingerspelling fix: detect the pair that is too close and open the
 * knuckles apart, rather than letting the meshes interpenetrate.
 *
 * The correction is applied to the abduction ANGLE, so it survives into the
 * next frame's smoothing instead of being a per-frame shove, and it is capped
 * per frame so that a deep collision opens over a few frames rather than
 * popping. */
const FINGER_PAIRS = [["Index", "Middle"], ["Middle", "Ring"], ["Ring", "Little"]];
const FINGER_GAP_RATIO = 0.62;   // of the knuckle spacing = twice a finger radius
const SEPARATE_MAX_STEP = 2.5;   // degrees per frame, per finger

function fingerChainPoints(side, finger) {
  const segs = FINGER_CHAINS[finger];
  const pts = [];
  for (const sname of segs) {
    const b = vrm.humanoid.getNormalizedBoneNode(`${side}${finger}${sname}`);
    if (b) pts.push(b.getWorldPosition(new THREE.Vector3()));
  }
  if (pts.length >= 2) {
    const last = pts[pts.length - 1], prev = pts[pts.length - 2];
    pts.push(last.clone().add(last.clone().sub(prev)));   // the tip, which has no bone
  }
  return pts;
}

function separateFingers(side) {
  const knuckleA = vrm.humanoid.getNormalizedBoneNode(`${side}IndexProximal`);
  const knuckleB = vrm.humanoid.getNormalizedBoneNode(`${side}LittleProximal`);
  if (!knuckleA || !knuckleB) return;
  const span = knuckleA.getWorldPosition(new THREE.Vector3())
    .distanceTo(knuckleB.getWorldPosition(new THREE.Vector3()));
  const gap = (span / 3) * TUNE.fingerGap;   // three gaps across four knuckles
  for (const [fa, fb] of FINGER_PAIRS) {
    const pa = fingerChainPoints(side, fa), pb = fingerChainPoints(side, fb);
    if (pa.length < 2 || pb.length < 2) continue;
    let closest = Infinity;
    for (let i = 0; i + 1 < pa.length; i++)
      for (let j = 0; j + 1 < pb.length; j++)
        closest = Math.min(closest, closestBetweenSegments(pa[i], pa[i + 1], pb[j], pb[j + 1]));
    if (!(closest < gap)) continue;
    const nameA = `${side}${fa}Proximal`, nameB = `${side}${fb}Proximal`;
    const ra = FINGER_REST[nameA], rb = FINGER_REST[nameB];
    const sa = FINGER_STATE[nameA], sb = FINGER_STATE[nameB];
    const ba = vrm.humanoid.getNormalizedBoneNode(nameA), bb = vrm.humanoid.getNormalizedBoneNode(nameB);
    if (!ra || !rb || !sa || !sb || !ba || !bb) continue;
    // how far apart the knuckles have to open to clear: a small angle at the
    // knuckle moves the fingertip by (angle x finger length)
    const len = Math.max(pa[0].distanceTo(pa[pa.length - 1]), 1e-4);
    const need = Math.min(SEPARATE_MAX_STEP, (gap - closest) / len * 180 / Math.PI * 0.5);
    // which way is apart: the sign of their offset along the shared spread axis
    const axis = ra.flex.clone().applyQuaternion(ba.parent.getWorldQuaternion(new THREE.Quaternion()));
    const dir = Math.sign(pa[pa.length - 1].clone().sub(pb[pb.length - 1]).dot(axis)) || 1;
    sa.abd = clampNum(sa.abd + dir * need, -ra.rom.abd, ra.rom.abd);
    sb.abd = clampNum(sb.abd - dir * need, -rb.rom.abd, rb.rom.abd);
    applyFingerState(ba, ra, sa);
    applyFingerState(bb, rb, sb);
  }
}

/* Ease a hand back to its rest shape when no landmarks arrive for it. Without
 * this the fingers freeze in whatever they last held — which is wrong at the
 * end of a sentence, where the arms lower to the sides while the hand is still
 * making the final sign. The time constant is long on purpose: 7.4% of frames
 * drop a hand and half of those last a single frame, and those must not
 * flicker. */
const TAU_HAND_RELAX = 0.25;
/* ── a hanging hand is a relaxed hand ────────────────────────────────
 * MediaPipe keeps "detecting" a hand that has dropped to the signer's side,
 * but at the frame edge its orientation is garbage: during 你 the lowered
 * left hand's demanded palm orientation swept the forearm through a full
 * turn and back (−30°→+174°→wrap→−178°→…), with detection nominally fine —
 * the visible arm-twist deformity. Signing happens at chest height; measured
 * over these clips, resting wrists sit below 0.3 of the hip→shoulder span
 * and actively signing wrists above 0.44. So below the threshold the wrist
 * and fingers relax toward neutral instead of following the data — which is
 * also what a real lowered hand does. The arm ITSELF keeps tracking: wrist
 * position is reliable, orientation is not. Hysteresis, so a hand hovering
 * at the boundary does not flicker between the two regimes. */
const LOW_HAND_ENTER = 0.28;
const LOW_HAND_LEAVE = 0.42;
/* palm-target angular-rate limits, deg/s: fastest measured real signing
 * pronation runs ~600; tracking garbage runs 1500+ */
const PALM_RATE_MAX = 700;
const PALM_RATE_REJECT = 1200;
const PALM_BAD_STREAK = 2;   // rejected frames tolerated before the hand relaxes

function relaxFingers(side, dt) {
  const alpha = smoothAlpha(dt, TAU_HAND_RELAX);
  for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
    for (const s of segs) {
      const name = `${side}${finger}${s}`;
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      if (!bone) continue;
      const st = FINGER_STATE[name];
      // the angles are the state now, so they have to relax as well — leaving
      // them at the last sign's values would snap the shape back the moment the
      // hand is detected again
      if (st) { st.flex *= 1 - alpha; st.abd *= 1 - alpha; }
      bone.quaternion.slerp(IDENTITY_Q, alpha);
    }
  }
}
const IDENTITY_Q = new THREE.Quaternion();

/* unwind the wrist and the forearm roll toward neutral as the arm comes down */
function relaxWrist(side, dt, weight) {
  const arm = ARM[side];
  if (!arm) return;
  const alpha = smoothAlpha(dt, TAU_HAND_RELAX) * weight;
  arm.hand.quaternion.slerp(IDENTITY_Q, alpha);
  if (arm.rollDeg != null) arm.rollDeg *= 1 - alpha;
  if (arm.roll) arm.roll.slerp(IDENTITY_Q, alpha);
}

function solveFingers(side, worldLms, dt) {
  const arm = ARM[side];
  if (!arm || !arm.restPalm || !worldLms) return;
  // rotation taking the signer's palm frame onto the avatar's rest palm frame
  const Bm = palmBasis(mpToAvatar(worldLms[0]), mpToAvatar(worldLms[9]),
    mpToAvatar(worldLms[5]), mpToAvatar(worldLms[17]));
  if (!Bm) return;   // degenerate palm this frame: hold the last handshape
  const alignQ = new THREE.Quaternion().setFromRotationMatrix(
    new THREE.Matrix4().multiplyMatrices(arm.restPalm, new THREE.Matrix4().copy(Bm).invert()),
  );
  // ...and then however the avatar's hand has actually moved since rest
  const R = arm.hand.getWorldQuaternion(new THREE.Quaternion())
    .multiply(arm.restQHand.clone().invert());
  const alpha = smoothAlpha(dt, TAU_FINGER);

  // the recording's own spread per finger, about its own palm normal
  const P = i => mpToAvatar(worldLms[i]);
  const srcDir = f => P(FINGER_LANDMARKS[f][1]).sub(P(FINGER_LANDMARKS[f][0]));
  const midDir = srcDir("Middle");
  const spread = {};
  for (const f of Object.keys(FINGER_CHAINS)) {
    spread[f] = midDir.lengthSq() > 1e-10
      ? spreadAgainstMiddle(side, srcDir(f), Bm, midDir.clone().normalize()) : 0;
  }

  for (const [finger, segs] of Object.entries(FINGER_CHAINS)) {
    const lm = FINGER_LANDMARKS[finger];
    let pipFlex = null;
    for (let i = 0; i < segs.length; i++) {
      const name = `${side}${finger}${segs[i]}`;
      const bone = vrm.humanoid.getNormalizedBoneNode(name);
      const rest = FINGER_REST[name];
      if (!bone || !rest) continue;
      const a = mpToAvatar(worldLms[lm[i]]);
      const b = mpToAvatar(worldLms[lm[i + 1]]);
      const d = b.clone().sub(a);
      if (d.lengthSq() < 1e-10) continue;
      // the recording's own joint angle: the turn from the previous phalanx
      // into this one. Measured inside the recording, so no mapping error.
      const prev = i === 0 ? a.clone().sub(mpToAvatar(worldLms[0]))
        : a.clone().sub(mpToAvatar(worldLms[lm[i - 1]]));
      const bend = prev.lengthSq() > 1e-10
        ? Math.acos(clampNum(prev.normalize().dot(d.clone().normalize()), -1, 1)) * 180 / Math.PI
        : 0;
      const solved = solveFingerJoint(name, bone, rest, spread[finger], bend, alpha, pipFlex);
      if (i === 1) pipFlex = solved;
    }
  }
  if (TUNE.separate) separateFingers(side);
}

/* ── wrist twist redistribution ──────────────────────────────────────
 * Measured on 我想去日本玩: the wrist bone was carrying a mean local
 * rotation of 119°(L)/136°(R), peaking at 178°. A real wrist manages about
 * ±80° of flexion and almost no axial twist, so the skin cluster around it
 * collapsed — the "deformed hand".
 *
 * The cause is upstream: aimLocal orients the forearm with a minimal-arc
 * rotation, which leaves its ROLL arbitrary. Forearm pronation is then
 * unaccounted for, and the wrist has to absorb all of it.
 *
 * So decompose the wrist's required rotation about the forearm's own axis,
 * hand the twist component to the forearm (which is what pronates in a real
 * arm), and leave the wrist only the residual bend — clamped per axis below.
 * Palm orientation is phonemic in sign language, so this also makes the signs
 * read correctly rather than merely stopping the mesh breaking: measured over
 * 15 signs, palm-orientation error against the recording fell from 43.9° mean
 * to 8.4° once the split was computed absolutely instead of incrementally. */
/* Anatomical ranges. A single 80° cone was better than nothing but still let
 * the wrist deviate 80° sideways, which no wrist does — the limits differ by
 * an order of magnitude between axes, so they are applied per axis:
 *   flexion / extension  about the across-palm axis   ~70–80°
 *   radial / ulnar dev.  about the palm normal        ~20–30°
 *   axial rotation       about the forearm            ~10–15° (the forearm
 *                                                      does the rest)      */
const WRIST_FLEX_DEG = 70;
const WRIST_DEV_DEG = 25;
const WRIST_TWIST_DEG = 15;
/* How much axial rotation the hand bone may take off the forearm. A wrist
 * itself only rotates about 15 degrees axially, but this rig has no twist
 * bone: whatever the forearm carries shears the mesh at the ELBOW, while what
 * the hand carries shears it at the wrist, where the skin weights blend over a
 * much shorter span and the sleeve hides it. So beyond the forearm's own range
 * the rotation is handed forward rather than left to pile up. The palm still
 * ends up where the recording put it — the two shares always sum to the same
 * rotation. */
const WRIST_TWIST_MAX = 35;
/* how fast the hand's twist share follows its target; also what freezes it
 * through one-frame detection dropouts */
const TAU_TWIST_SHARE = 0.15;
/* World-space palm-target smoothing was tried here at three strengths and
 * REJECTED as a default: palm orientation is phonemic, and even tau=0.05
 * cost +4° of mean palm error against the recording for only a modest cut
 * in transition wobble. Left as TUNE.palmTau (seconds; 0 = off) for console
 * experiments. The wobble that mattered — the post-pass twist see-saw —
 * was removed by folding the hand share into the absolute solve instead. */
/* Pronation/supination gets NO range limit, deliberately.
 *
 * The obvious move is to clamp it to a forearm's ~±85°, and that was tried.
 * It is wrong, because the angle is measured from the minimal-arc forearm aim,
 * whose zero is not anatomical neutral — the aim carries its own parasitic
 * roll that varies with the direction the forearm points. Measured over 20
 * signs the required angle is spread across the entire circle with no compact
 * mode, so an ±85° window is not an anatomical constraint but an arbitrary
 * one: it fired on 74.8% of frames, discarding 73° on average, and pushed the
 * palm-orientation error's 95th percentile from 68° to 120°. Palm orientation
 * is phonemic, so that is a real loss of meaning.
 *
 * What actually read as "the wrist flips" was never the angle's magnitude but
 * its DISCONTINUITY — a swing-twist decomposition hops branches near 180°. So
 * the derivative is constrained instead of the value: pick the branch nearest
 * last frame, and hold the rate to something a forearm can reach. */
const FOREARM_ROLL_DEG = null;
/* Rate limit on pronation, deg/s. A swing-twist decomposition is discontinuous
 * where the twist passes 180°: the same physical rotation is representable
 * either side, and the solve can hop between them on noise. Measured, that hop
 * produced single-frame forearm rolls of up to 171° — the visible "flip". The
 * branch is chosen by continuity (see rollAngle) and what is left is held to a
 * speed a forearm can actually reach; real signing pronation runs well inside
 * this, so it costs fidelity only during a hop that should not happen. */
const FOREARM_ROLL_RATE = 600;   // deg/s; measured real flips peak ~570, garbage runs 900+
/* Shoulder internal/external rotation. This angle is what aims the elbow
 * crease, so a tight limit would put the joint back where it started; measured
 * over 20 signs it stays inside -65°..+79° on its own, so the cap here is only
 * a backstop against a degenerate solve. Tracked and rate-limited for the same
 * continuity reason as the forearm. */
const UPPER_ROLL_DEG = 120;
const UPPER_ROLL_RATE = 900;
/* ── where the pronation is allowed to live ──────────────────────────
 * A VRoid rig has no twist bones: UpperArm → LowerArm → Hand and nothing in
 * between. Everything the forearm is asked to rotate therefore lands on one
 * joint, and the mesh around it shears — the "candy wrapper" that rigs
 * normally avoid with one or two dedicated twist joints between elbow and
 * wrist. Measured over eleven sentences the forearm was carrying 134 degrees
 * at the 95th percentile and 174 at worst, which no forearm reaches.
 *
 * The rotation cannot simply be discarded: palm orientation is phonemic, and
 * clamping it was tried and cost 52 degrees of palm error at the 95th
 * percentile. So it is moved instead of dropped. When the elbow is close to
 * straight the humerus and the forearm turn about the SAME axis, so shoulder
 * rotation substitutes for pronation exactly — which is also what a real arm
 * does once the forearm runs out of range. The excess is bled into the
 * shoulder over a few frames; the IK re-aims the forearm at the wrist target
 * afterwards, so nothing moves except the twist's distribution. */
const FOREARM_TWIST_SOFT = 80;    // degrees the forearm may hold on its own
const TWIST_BLEED_GAIN = 0.25;    // fraction of the excess handed over per frame
const TWIST_BLEED_TAU = 0.30;     // how fast the loan is repaid once it is not needed

/* signed rotation angle of q about `axis`, in degrees, wrapped to (-180, 180] */
const wrapDeg = d => d - 360 * Math.round(d / 360);
function twistDeg(q, axis) {
  const v = new THREE.Vector3(q.x, q.y, q.z);
  return wrapDeg(2 * Math.atan2(v.dot(axis), q.w) * 180 / Math.PI);
}
const clampNum = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

/* Track a roll angle over time: pick the branch nearest last frame (±360 is
 * the SAME rotation, so this is free), hold it inside its anatomical range,
 * and rate-limit what remains. `state` is the per-arm slot holding last frame's
 * value; returns the angle to use, in degrees. */
function trackRoll(arm, key, deg, dt, maxDeg, rate) {
  const prev = arm[key];
  const first = prev === undefined || prev === null;
  // nearest branch to last frame: ±360 is the same rotation, so this is free
  let a = first ? deg : prev + wrapDeg(deg - prev);
  noteVal(key, a);
  if (maxDeg !== null) {
    const clamped = clampNum(a, -maxDeg, maxDeg);
    note(`${key}:range`, Math.abs(a - clamped));
    a = clamped;
  }
  if (!first) {
    const step = rate * Math.max(dt, 1e-4);
    const rated = prev + clampNum(a - prev, -step, step);
    note(`${key}:rate`, Math.abs(a - rated));
    a = rated;
  }
  // Store a canonical representative. Without this the unwrapping accumulates
  // and the angle drifts away over a long sentence; with it, next frame's
  // unwrap still finds the nearest branch, so nothing is lost.
  arm[key] = wrapDeg(a);
  return a;
}

/* ── which limit is actually binding ─────────────────────────────────
 * Every constraint here trades joint plausibility against how faithfully the
 * palm ends up oriented, and palm orientation is phonemic — so it is worth
 * knowing, per limit, how often it fires and by how much, rather than tuning
 * the numbers by eye. Read via Avatar3D.jointStats. */
const JOINT_STATS = {};

function note(key, excessDeg) {
  const s = JOINT_STATS[key] || (JOINT_STATS[key] = { n: 0, hit: 0, sum: 0, max: 0 });
  s.n++;
  if (excessDeg > 0.05) {
    s.hit++;
    s.sum += excessDeg;
    s.max = Math.max(s.max, excessDeg);
  }
}

/* distribution of a raw angle, for calibrating a limit against real data */
const JOINT_HIST = {};
function noteVal(key, deg) {
  const h = JOINT_HIST[key] || (JOINT_HIST[key] = { n: 0, sum: 0, min: 1e9, max: -1e9, bins: {} });
  h.n++; h.sum += deg;
  h.min = Math.min(h.min, deg); h.max = Math.max(h.max, deg);
  const b = Math.round(deg / 20) * 20;
  h.bins[b] = (h.bins[b] || 0) + 1;
}

function resetJointStats() {
  for (const k of Object.keys(JOINT_HIST)) delete JOINT_HIST[k];
  for (const k of Object.keys(JOINT_STATS)) delete JOINT_STATS[k];
}

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

/* Clamp a pure swing (axis ⟂ `axis`) inside an ELLIPTICAL cone, so flexion and
 * deviation get their own limits. The swing is exactly the rotation that takes
 * the forearm axis onto the palm's pointing direction, so it can be clamped
 * where it is legible: as that direction's tilt out of the axis, resolved into
 * a flexion component (along the palm normal) and a deviation component
 * (across the palm). */
function clampSwingElliptic(swing, axis, n, c, flexDeg, devDeg) {
  const tilted = axis.clone().applyQuaternion(swing);
  const f = tilted.dot(n), d = tilted.dot(c);
  const sf = Math.sin(flexDeg * Math.PI / 180), sd = Math.sin(devDeg * Math.PI / 180);
  const e = Math.hypot(f / sf, d / sd);
  note("wrist:bend", e > 1 ? (Math.asin(Math.min(1, Math.hypot(f, d)))
    - Math.asin(Math.min(1, Math.hypot(f, d) / e))) * 180 / Math.PI : 0);
  if (e <= 1 && tilted.dot(axis) >= 0) return swing;
  const f2 = e > 1 ? f / e : f;
  const d2 = e > 1 ? d / e : d;
  const along = Math.sqrt(Math.max(0, 1 - f2 * f2 - d2 * d2));
  const out = axis.clone().multiplyScalar(along)
    .add(n.clone().multiplyScalar(f2)).add(c.clone().multiplyScalar(d2)).normalize();
  return new THREE.Quaternion().setFromUnitVectors(axis, out);
}

/* returns false when the hand's data is too corrupt to apply — the caller
 * then treats the hand as undetected (fingers and wrist relax) */
function rigHand(side, handLms, worldLms, dt = 0.016) {
  const lower = side.toLowerCase();

  // wrist orientation: exact palm plane from the world landmarks
  const arm = ARM[lower];
  if (arm && arm.restPalm && arm.lowerAim && worldLms) {
    const w = mpToAvatar(worldLms[0]);
    const basis = palmBasis(w, mpToAvatar(worldLms[9]), mpToAvatar(worldLms[5]), mpToAvatar(worldLms[17]));
    if (!basis) return true;   // degenerate palm this frame: hold, do not relax
    const delta = new THREE.Quaternion()
      .setFromRotationMatrix(basis)
      .multiply(new THREE.Quaternion().setFromRotationMatrix(arm.restPalm).invert());
    const handWorldRaw = delta.multiply(arm.restQHand.clone());
    /* ── physiological gate on the palm target ───────────────────────
     * Measured on 你: the recording's own left-palm orientation rotated 53-60°
     * in single frames (≈1800°/s — no wrist does that) exactly where the
     * forearm wound through a full turn: a lowering hand at the frame edge
     * keeps "detecting" but its orientation is garbage. This is a GATE, not a
     * filter: anything a human wrist can do (measured signing peaks ~600°/s)
     * passes untouched with zero lag; above PALM_RATE_MAX the target follows
     * at that cap; above PALM_RATE_REJECT the frame is discarded outright and
     * the last accepted orientation holds, same as a degenerate palm basis. */
    if (arm.lastPalmQ) {
      const rate = arm.lastPalmQ.angleTo(handWorldRaw) * 180 / Math.PI / Math.max(dt, 1e-3);
      if (rate > PALM_RATE_REJECT) {
        /* Holding the last orientation is only right for a blink: if the arm
         * is moving, a world-frozen palm forces the forearm to wind up — 你's
         * lowering hand measured 175° of bone twist that way. So persistent
         * garbage hands over the whole solve to the relax path (fingers and
         * wrist ease to neutral, like an undetected hand) until the data
         * behaves again. */
        arm.palmBad = (arm.palmBad || 0) + 1;
        if (arm.palmBad > PALM_BAD_STREAK) return false;
        handWorldRaw.copy(arm.lastPalmQ);
      } else {
        if (arm.palmBad) arm.palmBad = Math.max(0, arm.palmBad - 2);
        if (rate > PALM_RATE_MAX) {
          const capped = arm.lastPalmQ.clone();
          capped.rotateTowards(handWorldRaw, PALM_RATE_MAX * Math.PI / 180 * Math.max(dt, 1e-3));
          handWorldRaw.copy(capped);
        }
      }
    }
    arm.lastPalmQ = handWorldRaw.clone();
    /* ── smooth the palm TARGET, in world space ──────────────────────
     * The wobble lives in the measured palm orientation (blend artifacts,
     * landmark noise); the forearm's local twist merely reproduces it. The
     * first attempt smoothed the local twist instead, and that broke the
     * counter-rotation an arm swing legitimately needs — palm error tripled.
     * Filtering the world-space target is level-correct: real pronation lags
     * by ~TAU_PALM and is capped at PALM_RATE (both beyond signing speeds),
     * a zero-mean wobble mostly cancels, and arm motion is untouched. */
    let handWorld = handWorldRaw;
    if (TUNE.palmTau > 0) {
      if (!arm.palmSmoothQ) arm.palmSmoothQ = handWorldRaw.clone();
      else {
        const gap = arm.palmSmoothQ.angleTo(handWorldRaw);
        if (gap > 1e-5)
          arm.palmSmoothQ.rotateTowards(handWorldRaw, gap * smoothAlpha(dt, TUNE.palmTau));
        noteVal("wrist:palmWobble", arm.palmSmoothQ.angleTo(handWorldRaw) * 180 / Math.PI);
      }
      handWorld = arm.palmSmoothQ.clone();
    } else {
      arm.palmSmoothQ = null;
    arm.wristLow = false;
    arm.prevWristH = null;

    arm.lastPalmQ = null;
    arm.palmBad = 0;
    arm.prevRel = null;
    arm.relSpeedS = null;
    }

    // Decompose against the ROLL-FREE forearm aim, not against wherever the
    // forearm happens to be sitting. That reference is recomputed from the IK
    // every frame, so the split below is absolute — it cannot accumulate, and
    // a dropped hand costs one frame of roll rather than leaving the forearm
    // wound up for the rest of the sign.
    const upperQ = arm.lower.parent.getWorldQuaternion(new THREE.Quaternion());
    const aimWorld = upperQ.multiply(arm.lowerAim);
    const local = aimWorld.clone().invert().multiply(handWorld);
    const axis = arm.axisLower;

    // local = twist · swing, twist about the forearm's own long axis
    const twist = twistAbout(local, axis);
    const swing = twist.clone().invert().multiply(local);

    // The forearm pronates — that is the joint that actually rotates in an
    // arm, and giving it the twist is what stopped the wrist carrying 119–136°
    // of it. The angle is tracked as a scalar rather than taken straight off
    // the quaternion, so the decomposition's 180° branch cut cannot read as a
    // flip. What the forearm cannot reach is capped rather than dumped back: a
    // slightly wrong palm angle is a far smaller error than a broken joint.
    const rollDeg = trackRoll(arm, "rollDeg", twistDeg(twist, axis), dt,
      FOREARM_ROLL_DEG, FOREARM_ROLL_RATE);
    /* ── hand share of the twist, solved absolutely ──────────────────
     * The forearm's total twist is mostly the minimal-arc aim's parasitic
     * roll, not rollDeg, so the excess is measured on what the bone will
     * actually be set to. The share the hand takes is then folded into THIS
     * frame's decomposition: forearm gets R(roll − share), the hand's local
     * target gets R(+share) in front, and the palm's world orientation is
     * unchanged by construction.
     *
     * The first version did this as a post-pass that premultiplied the bones
     * after the solve. That fought the solve instead of joining it — the IK
     * re-aim pulled the forearm back toward full twist at ~56%/frame while
     * the post-pass subtracted it again, a standing see-saw measured at 21°
     * of twist change per frame (96° worst) — the "wrist keeps twisting".
     * Inside the solve there is nothing to fight; the share is smoothed and
     * HELD on frames where the hand is not detected, never dropped. */
    const willBe = arm.lowerAim.clone().multiply(rollQuat(axis, rollDeg * Math.PI / 180));
    const twTotal = twistDeg(twistAbout(willBe, axis), axis);
    const targetShare = clampNum(
      Math.sign(twTotal) * Math.max(0, Math.abs(twTotal) - TUNE.twistSoft),
      -TUNE.twistToHand, TUNE.twistToHand);
    if (arm.handTwistDeg == null) arm.handTwistDeg = 0;
    arm.handTwistDeg += (targetShare - arm.handTwistDeg) * smoothAlpha(dt, TAU_TWIST_SHARE);
    noteVal("wrist:handShare", arm.handTwistDeg);
    const roll = rollQuat(axis, (rollDeg - arm.handTwistDeg) * Math.PI / 180);
    const spare = rollQuat(axis, rollDeg * Math.PI / 180).invert().multiply(twist);
    const leftover = rollQuat(axis, arm.handTwistDeg * Math.PI / 180)
      .multiply(clampSwing(spare, WRIST_TWIST_DEG));
    note("wrist:twist", 2 * Math.acos(Math.min(1, Math.abs(spare.w))) * 180 / Math.PI
      - 2 * Math.acos(Math.min(1, Math.abs(leftover.w))) * 180 / Math.PI);
    arm.roll = roll;

    const bendLimited = arm.palmN
      ? clampSwingElliptic(swing, axis, arm.palmN, arm.palmC, WRIST_FLEX_DEG, WRIST_DEV_DEG)
      : clampSwing(swing, WRIST_FLEX_DEG);

    const alpha = smoothAlpha(dt, TAU_ARM);
    arm.lower.quaternion.slerp(arm.lowerAim.clone().multiply(roll), alpha);
    arm.lower.updateWorldMatrix(true, true);
    arm.hand.quaternion.slerp(leftover.multiply(bendLimited), alpha);
  }

  // handshape straight from the 21 landmarks
  solveFingers(lower, worldLms, dt);
  return true;
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
  // Gains halved from 0.5/0.6: the shoulders hang off the chest, so every
  // degree here travels straight to the shoulder line, and a stable shoulder
  // is worth more than the extra bit of torso life.
  rigRotation("chest", {
    x: 0,
    y: -Math.atan2(d.z, Math.abs(d.x)) * 0.25,  // one shoulder forward → slight turn
    z: Math.atan2(d.y, Math.abs(d.x)) * 0.3,    // shoulder tilt → slight lean
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
  let restW = 0;
  if (frame.pose) {
    const vis = frame.pose.visibility;
    const visOK = i => (vis ? vis[i] : 1) >= 0.4;
    const hasHand = side => (frame.hands || []).some(h => h.handedness.toLowerCase() === side);
    const body = frame._body || null;  // composer's per-segment median body scale
    rigTorso(frame.pose.world_landmarks, step);
    holdShoulders(step);
    restW = Math.min(1, Math.max(0, frame._rest || 0));
    solveArm("left", frame.pose.world_landmarks, visOK, hasHand("left"), body, step, restW);
    solveArm("right", frame.pose.world_landmarks, visOK, hasHand("right"), body, step, restW);
    rigHead(poseLm(frame.pose.landmarks, frame.pose.visibility, false));
  }
  // which wrists are hanging low (see LOW_HAND_ENTER): update the hysteresis
  if (frame.pose && frame.pose.world_landmarks) {
    const lm = frame.pose.world_landmarks;
    for (const side of ["left", "right"]) {
      const arm = ARM[side];
      if (!arm) continue;
      const wri = lm[side === "left" ? 15 : 16], sho = lm[side === "left" ? 11 : 12],
        hip = lm[side === "left" ? 23 : 24];
      const span = hip[1] - sho[1];
      const h = span > 1e-6 ? (hip[1] - wri[1]) / span : 1;
      /* Absolute height only. A drop-from-recent-peak detector was tried here
       * to catch the hand EARLIER on its way down — and it relaxed live signs
       * instead: ordinary downward strokes (謝謝's bow, 不會's press) fall just
       * as far below their own peak as a retraction does, and finger error
       * doubled. Below 0.28 of the hip→shoulder span nothing linguistic
       * happens in this corpus; above it, follow the data. */
      arm.wristLow = arm.wristLow ? h < LOW_HAND_LEAVE : h < LOW_HAND_ENTER;
    }
  }
  const seen = new Set();
  for (const h of frame.hands || []) {
    const side = h.handedness.toLowerCase();
    if (ARM[side] && ARM[side].wristLow) continue;   // hanging: data untrustworthy
    if (rigHand(h.handedness, handLm(h.landmarks), h.world_landmarks, step)) seen.add(side);
  }
  for (const side of ["left", "right"]) if (!seen.has(side)) relaxFingers(side, step);
  // a hanging arm also has a neutral wrist, not the last sign's palm angle
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    const w = Math.max(frame._rest || 0,
      arm && (arm.wristLow || (arm.palmBad || 0) > PALM_BAD_STREAK) ? 1 : 0);
    if (w > 0) relaxWrist(side, step, w);
  }
  // after the handshape exists, measure contacts and ease the correction
  // that solveArm will apply (one frame of lag, but no popping)
  updateCollisionCorrections(step, restW);
  rigFace(frame.face ? frame.face.blendshapes : null, step);
  vrm.update(dt || 0.016);
}

/* ── standing still ──────────────────────────────────────────────────
 * update() needs a frame, and there is no frame before the first sentence
 * finishes loading — so the model held its bind pose, arms straight out to
 * the sides, for the whole wait. That reads as broken rather than loading.
 *
 * This drives the same rest posture the end of every sentence settles into,
 * so the avatar simply stands there: nothing to watch, which is the point.
 * It is the pose the sentence will start from, so there is no jump when
 * playback begins either. */
function idle(dt) {
  if (!ready) return;
  const step = Math.min(Math.max(dt || 0.016, 1e-4), 0.1);
  vrm.scene.rotation.y = Math.PI + TUNE.sceneYaw;
  holdShoulders(step);
  for (const side of ["left", "right"]) {
    const arm = ARM[side];
    if (!arm) continue;
    const S = arm.upper.getWorldPosition(new THREE.Vector3());
    const reach = (arm.L1 + arm.L2) * REST_REACH;
    const T = S.clone().add(restReach(side, reach));
    arm.lastS = S.clone();
    arm.lastT = T.clone();
    aimArm(side, S, T, restPole(side, reach * 0.5), smoothAlpha(step, TAU_ARM), step, 1);
    relaxFingers(side, step);
    relaxWrist(side, step, 1);
  }
  rigFace(null, step);
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
  idle,
  setCamera,
  resize,
  render,
  resetSmoothing,
  tune: TUNE,
  get vrm() { return vrm; },  // console calibration: expressions, bones, morphs
  get volumes() { return VOL; },
  get limbs() { return LIMB; },
  get corrections() { return { wrist: CORR, pole: POLE_CORR }; },
  get jointStats() { return JOINT_STATS; },
  get arms() { return ARM; },   // diagnostics: per-arm solver state
  get body() { return BODY; },   // diagnostics: mapping basis
  get fingerRest() { return FINGER_REST; },
  get fingerState() { return FINGER_STATE; },
  get fingerDebug() { return FINGER_DEBUG; },
  get jointHist() { return JOINT_HIST; },
  resetJointStats,
  get pushStats() { return PUSH_STATS; },
  get expressionNames() { return [...EXPR.lookup.values()]; },
  smoothing: { get TAU_TARGET() { return TAU_TARGET; }, get TAU_ARM() { return TAU_ARM; } },
  get ready() { return ready; },
};
