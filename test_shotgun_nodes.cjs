// Scratch tool: replicate WeaponSystem's viewmodel transform chain offline so
// the shotgun's loading port and support-hand targets can be checked without a
// browser. Prints NDC (on-screen?) for candidate reload poses.
const fs = require('fs');

// ---------------------------------------------------------------- GLB parse
const buffer = fs.readFileSync('public/models/shotgun.glb');
const jsonLength = buffer.readUInt32LE(12);
const gltf = JSON.parse(buffer.subarray(20, 20 + jsonLength).toString());
const binOffset = 20 + jsonLength + 8;
const bin = buffer.subarray(binOffset, binOffset + buffer.readUInt32LE(binOffset));
const { nodes, meshes, bufferViews, accessors } = gltf;
const COMP = { SCALAR: 1, VEC2: 2, VEC3: 3, VEC4: 4, MAT4: 16 };

function readAccessor(index) {
  const accessor = accessors[index];
  const view = bufferViews[accessor.bufferView];
  const size = COMP[accessor.type];
  const stride = view.byteStride || size * 4;
  const base = (view.byteOffset || 0) + (accessor.byteOffset || 0);
  const out = [];
  for (let i = 0; i < accessor.count; i += 1) {
    const at = base + i * stride;
    out.push([bin.readFloatLE(at), bin.readFloatLE(at + 4), bin.readFloatLE(at + 8)]);
  }
  return out;
}

function mul(a, b) {
  const out = new Array(16).fill(0);
  for (let c = 0; c < 4; c += 1) {
    for (let r = 0; r < 4; r += 1) {
      out[c * 4 + r] = a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
    }
  }
  return out;
}

function trs(node) {
  if (node.matrix) return node.matrix.slice();
  const [tx, ty, tz] = node.translation || [0, 0, 0];
  const [qx, qy, qz, qw] = node.rotation || [0, 0, 0, 1];
  const x2 = qx + qx; const y2 = qy + qy; const z2 = qz + qz;
  const xx = qx * x2; const xy = qx * y2; const xz = qx * z2;
  const yy = qy * y2; const yz = qy * z2; const zz = qz * z2;
  const wx = qw * x2; const wy = qw * y2; const wz = qw * z2;
  return [
    1 - (yy + zz), xy + wz, xz - wy, 0,
    xy - wz, 1 - (xx + zz), yz + wx, 0,
    xz + wy, yz - wx, 1 - (xx + yy), 0,
    tx, ty, tz, 1,
  ];
}

const parents = new Map();
nodes.forEach((node, i) => (node.children || []).forEach((child) => parents.set(child, i)));
const worldCache = new Map();
function worldMatrix(index) {
  if (worldCache.has(index)) return worldCache.get(index);
  const local = trs(nodes[index]);
  const parent = parents.get(index);
  const world = parent === undefined ? local : mul(worldMatrix(parent), local);
  worldCache.set(index, world);
  return world;
}
const xf = (m, v) => [
  m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
  m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
  m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
];

/** three.js Euler 'XYZ' -> rotation matrix, column-major, exactly as three does. */
function eulerMatrix(x, y, z) {
  const a = Math.cos(x); const b = Math.sin(x);
  const c = Math.cos(y); const d = Math.sin(y);
  const e = Math.cos(z); const f = Math.sin(z);
  const ae = a * e; const af = a * f; const be = b * e; const bf = b * f;
  const m = new Array(16).fill(0);
  m[0] = c * e;        m[4] = -c * f;       m[8] = d;
  m[1] = af + be * d;  m[5] = ae - bf * d;  m[9] = -b * c;
  m[2] = bf - ae * d;  m[6] = be + af * d;  m[10] = a * c;
  m[15] = 1;
  return m;
}

// ------------------------------------------------ the chain, as three.js does
const TARGET_LENGTH = 1.45;
const VIEW_SCALE = 1.34;
const HOLDER_BASE = [0.18, -0.37, -0.35];
const BASE_ROT = [0.0, -0.06, 0.0];
const NEAR = 0.045;
const FOV = 80;

const ASSET_ROT = eulerMatrix(0, Math.PI / 2, 0);

// Asset fit, at UNIT scale first: loadConfiguredModel measures the bounds after
// the rotation but before scaling, then scales by targetLength / longSide.
const unit = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
const raw = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
nodes.forEach((node, i) => {
  if (node.mesh === undefined) return;
  const primitive = meshes[node.mesh]?.primitives?.[0];
  if (!primitive) return;
  const m = worldMatrix(i);
  readAccessor(primitive.attributes.POSITION).forEach((p) => {
    const w = xf(m, p);
    const r = xf(ASSET_ROT, w);
    w.forEach((v, a) => { raw.lo[a] = Math.min(raw.lo[a], v); raw.hi[a] = Math.max(raw.hi[a], v); });
    r.forEach((v, a) => { unit.lo[a] = Math.min(unit.lo[a], v); unit.hi[a] = Math.max(unit.hi[a], v); });
  });
});
const assetScale = TARGET_LENGTH / Math.max(unit.hi[0] - unit.lo[0], unit.hi[2] - unit.lo[2], 0.001);
// Centre of the ROTATED + SCALED bounds - this is what gets subtracted.
const assetCentre = [0, 1, 2].map((a) => {
  const c = (unit.lo[a] + unit.hi[a]) / 2 * assetScale;
  return c;
});
console.log(`raw size      = [${[0, 1, 2].map((a) => (raw.hi[a] - raw.lo[a]).toFixed(4)).join(', ')}]`);
console.log(`rotated size  = [${[0, 1, 2].map((a) => (unit.hi[a] - unit.lo[a]).toFixed(4)).join(', ')}]`);
console.log(`asset scale   = ${assetScale.toFixed(6)}`);
console.log(`asset centre  = [${assetCentre.map((v) => v.toFixed(4)).join(', ')}]`);

/** Raw asset world point -> WeaponModel space. */
const toModel = (p) => {
  const r = xf(ASSET_ROT, [p[0] * assetScale, p[1] * assetScale, p[2] * assetScale]);
  return [r[0] - assetCentre[0], r[1] - assetCentre[1], r[2] - assetCentre[2]];
};

const nodeIndex = (name) => nodes.findIndex((n) => n.name === name);
const nodeWorld = (name) => xf(worldMatrix(nodeIndex(name)), [0, 0, 0]);

// The loading port: the rear face of the magazine tube the insert node hangs,
// measured in that node's own local frame along its +X axis (+X = muzzle).
const insertIdx = nodeIndex('shell insert point');
const insertWorld = nodeWorld('shell insert point');
const tube = (() => {
  const b = { lo: [Infinity, Infinity, Infinity], hi: [-Infinity, -Infinity, -Infinity] };
  const m = worldMatrix(insertIdx);
  const primitive = meshes[nodes[insertIdx].mesh]?.primitives?.[0];
  readAccessor(primitive.attributes.POSITION).forEach((p) => {
    const w = xf(m, p);
    w.forEach((v, a) => { b.lo[a] = Math.min(b.lo[a], v); b.hi[a] = Math.max(b.hi[a], v); });
  });
  // The node is unrotated, so subtracting its origin IS its local frame.
  return { lo: [0, 1, 2].map((a) => b.lo[a] - insertWorld[a]), hi: [0, 1, 2].map((a) => b.hi[a] - insertWorld[a]) };
})();
const mouthRaw = [
  insertWorld[0] + tube.lo[0],
  insertWorld[1] + (tube.lo[1] + tube.hi[1]) / 2,
  insertWorld[2] + (tube.lo[2] + tube.hi[2]) / 2,
];

const PORT = toModel(mouthRaw);
const insertModel = toModel(insertWorld);
const TUBE_DIR = [0, 1, 2].map((a) => toModel([insertWorld[0] + 1, insertWorld[1], insertWorld[2]])[a] - insertModel[a]);
console.log(`\ninsert node raw     = [${insertWorld.map((v) => v.toFixed(4)).join(', ')}]`);
console.log(`tube local box      = lo[${tube.lo.map((v) => v.toFixed(4))}] hi[${tube.hi.map((v) => v.toFixed(4))}]`);
console.log(`PORT   (model space)= [${PORT.map((v) => v.toFixed(4)).join(', ')}]`);
console.log(`insert (model space)= [${insertModel.map((v) => v.toFixed(4)).join(', ')}]`);
console.log(`TUBE_DIR (model)    = [${TUBE_DIR.map((v) => v.toFixed(4)).join(', ')}]`);

const HAND_REST = [-0.04, -0.01, -0.20];
console.log(`HAND_REST (model)   = [${HAND_REST.join(', ')}]`);

// A 12-gauge round is 60 mm long, so the shell prop is built to that. The hand
// grips it this far from its nose, which is what sets where the hand has to
// stand for the shell's nose to reach the port.
const SHELL_LENGTH = 0.060;
const HAND_TO_NOSE = 0.075;
const tubeDir = (() => {
  const len = Math.hypot(...TUBE_DIR);
  return TUBE_DIR.map((v) => v / len);
})();
const HAND_AT_PORT = [0, 1, 2].map((a) => PORT[a] - tubeDir[a] * HAND_TO_NOSE);
console.log(`HAND_AT_PORT (model)= [${HAND_AT_PORT.map((v) => v.toFixed(4)).join(', ')}]`);

const toCamera = (modelPoint, pose) => {
  const r = eulerMatrix(BASE_ROT[0] + pose.pitch, BASE_ROT[1] + pose.yaw, BASE_ROT[2] + pose.roll);
  const local = xf(r, modelPoint.map((v) => v * VIEW_SCALE));
  return [
    HOLDER_BASE[0] + pose.offset[0] + local[0],
    HOLDER_BASE[1] + pose.offset[1] + local[1],
    HOLDER_BASE[2] + pose.offset[2] + local[2],
  ];
};

function project(cam) {
  const dist = -cam[2];
  if (dist <= NEAR) return null;
  const halfH = dist * Math.tan((FOV / 2) * Math.PI / 180);
  return { ndcX: cam[0] / halfH, ndcY: cam[1] / halfH, dist, halfH };
}
const fmt = (v, size = 0) => (v
  ? `x=${v.ndcX.toFixed(2).padStart(5)} y=${v.ndcY.toFixed(2).padStart(5)} d=${v.dist.toFixed(3)}`
    + (size ? ` handFrac=${(size / (2 * v.halfH)).toFixed(2)}` : '')
  : ' BEHIND NEAR PLANE');

const MUZZLE = toModel(nodeWorld('bulletspawnpoint'));
const STOCK = toModel(nodeWorld('m1014 stock'));
const GRIP = HAND_AT_PORT;

// ---------------------------------------------------------------- candidate poses
// `magSwap` is exactly what WeaponSystem's existing mag-reload block applies to
// the rifles and the sniper, reused verbatim: roll left 0.95, the small pitch
// that comes with it, and the same tiny down-and-left shift. If the port is
// reachable from there the shotgun needs no pose of its own.
// Candidate poses, all with a ZERO position offset - the gun must not move,
// only turn. The roll is held at the value the rifles' mag-swap tilt already
// uses (-0.95, cant left); pitch and yaw are swept to find the rotation that
// brings the tube mouth into frame while keeping the muzzle in it.
// What the shotgun actually does now: it has no pose of its own, so during a
// reload it gets exactly the mag-swap tilt WeaponSystem applies to the rifles
// and the sniper - roll left 0.95, the pitch that comes with it, and the small
// down-and-left shift that is part of that same block. `hip` is the no-reload
// reference, so the two together show the whole movement the player sees.
const canted = { name: 'during reload: the shared mag-swap tilt', offset: [-0.076, -0.057, 0], roll: -0.95, yaw: 0, pitch: 0.114 };
const POSES = {
  hip: { name: 'hip (not reloading)', offset: [0, 0, 0], roll: 0, yaw: 0, pitch: 0 },
  canted,
};

// Where the next round is picked up from, relative to the port in model space:
// down, inboard and slightly back, so the hand dips toward the shooter's belt
// and comes back up to the tube.
const SHELL_SOURCE = [0, 1, 2].map((a) => PORT[a] + [-0.10, -0.15, 0.10][a]);
const SHELL_SOURCE_NOSE = [0, 1, 2].map((a) => SHELL_SOURCE[a] + tubeDir[a] * HAND_TO_NOSE);
const SHELL_SOURCE_CENTRE = [0, 1, 2].map((a) => SHELL_SOURCE[a] + tubeDir[a] * (HAND_TO_NOSE - SHELL_LENGTH / 2));
const SHELL_IN_CENTRE = [0, 1, 2].map((a) => PORT[a] + tubeDir[a] * (SHELL_LENGTH / 2));
const SHELL_IN_HAND_CENTRE = [0, 1, 2].map((a) => GRIP[a] + tubeDir[a] * (HAND_TO_NOSE - SHELL_LENGTH / 2));

console.log(`\nSHELL_SOURCE (model) = [${SHELL_SOURCE.map((v) => v.toFixed(4)).join(', ')}]`);
console.log(`source shell centre  = [${SHELL_SOURCE_CENTRE.map((v) => v.toFixed(4)).join(', ')}]`);
console.log(`aligned shell centre = [${SHELL_IN_CENTRE.map((v) => v.toFixed(4)).join(', ')}]`);

const ROWS = [
  ['hand rest (grip)', HAND_REST, 0.10],
  ['shell source hand', SHELL_SOURCE, 0.10],
  ['shell source round', SHELL_SOURCE_CENTRE, 0.06],
  ['port', PORT, 0],
  ['hand at port', GRIP, 0.10],
  ['shell at port', SHELL_IN_CENTRE, 0.06],
  ['shell in hand', SHELL_IN_HAND_CENTRE, 0.06],
  ['muzzle', MUZZLE, 0],
  ['stock', STOCK, 0],
];

// WeaponSystem.shellPortVisible() gates the hand's reach on the port being
// inside this window, so the two rows that matter for the reload are the port
// and the point the fist has to stand at.
const VISIBLE_LIMIT = 1.2;
const inView = (p) => p && Math.abs(p.ndcX) < VISIBLE_LIMIT && Math.abs(p.ndcY) < VISIBLE_LIMIT;

Object.entries(POSES).forEach(([key, pose]) => {
  console.log(`\n=== ${key}: ${pose.name} ===`);
  ROWS.forEach(([label, point, size]) => {
    console.log(`   ${label.padEnd(18)} ${fmt(project(toCamera(point, pose)), size)}`);
  });
  // The gun has to stay in frame whatever the reload does, or the player is
  // watching a weapon that has left.
  const muzzle = project(toCamera(MUZZLE, pose));
  console.log(`   ${'muzzle in frame'.padEnd(18)} ${inView(muzzle) ? 'yes' : 'NO - the gun has left the screen'}`);
  const portVisible = inView(project(toCamera(PORT, pose)));
  const handVisible = inView(project(toCamera(GRIP, pose)));
  console.log(`   ${'port visible'.padEnd(18)} ${portVisible ? 'yes' : 'no - hand stays on the grip'}`);
  console.log(`   ${'hand target visible'.padEnd(18)} ${handVisible ? 'yes' : 'NO - the hand would dive out of frame'}`);
});



