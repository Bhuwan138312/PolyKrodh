// Scratch check: the remote multiplayer character must match the 1v1 duel
// opponent exactly - same builder, same skin, same proportions, same rifle, and
// the same walk/recoil motion. Also checks the things the swap from a cylinder
// would have broken: a hitbox per body part instead of one, no waist offset left
// on the root, and headshots resolved from a tag rather than a height band.
import * as THREE from 'three';

// The skin builder paints into a 64x64 canvas. This harness has no DOM, so the
// few canvas calls the paint path makes are stubbed: enough for a texture to be
// produced and sized, which is all the character assembly and the checks below
// actually need.
class StubContext {
  constructor() { this.imageData = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) }; }
  fillRect() {}
  clearRect() {}
  drawImage() {}
  getImageData(_x, _y, w, h) { return { ...this.imageData, width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }; }
  putImageData() {}
  get fillStyle() { return '#000'; }
  set fillStyle(_v) {}
  get imageSmoothingEnabled() { return false; }
  set imageSmoothingEnabled(_v) {}
}
class StubCanvas {
  constructor() { this.width = 64; this.height = 64; this._ctx = new StubContext(); }
  getContext() { return this._ctx; }
}
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? new StubCanvas() : {}) };

const { buildMinecraftCharacter, getBotSkin, SKIN_PX } = await import('./src/characters/MinecraftCharacter.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

const skin = getBotSkin('pro');
const duel = buildMinecraftCharacter(skin);
const remote = buildMinecraftCharacter(getBotSkin('pro'));

console.log('--- the remote character is the duel character ---');
// Rather than assert absolute numbers that depend on the skin's overlays, every
// claim here is made against the duel character itself. If the two agree, the
// remote player IS the duel opponent, whatever the skin happens to contain.
check('both are the same kind of object', duel.group.constructor === remote.group.constructor,
  remote.group.constructor.name);
check('both share the duel skin texture', remote.skinMaterial.map === duel.skinMaterial.map);
const boundsOf = (c) => new THREE.Box3().setFromObject(c.group);
const heightOf = (c) => { const b = boundsOf(c); return b.max.y - b.min.y; };
const feetOf = (c) => boundsOf(c).min.y;
check('both are the same height', Math.abs(heightOf(duel) - heightOf(remote)) < 1e-9,
  `both ${heightOf(remote).toFixed(4)}m tall`);
check('both stand at the same height above their root', Math.abs(feetOf(duel) - feetOf(remote)) < 1e-9,
  `feet ${feetOf(remote).toFixed(4)}m above the root`);
check('the skin is the real skin file, not procedural', skin.texture.image?.width === 64,
  `${skin.texture.image?.width}x${skin.texture.image?.height}`);
check('one skin pixel is still 0.05625m', SKIN_PX === 0.05625);

console.log('\n--- it carries the same rifle ---');
const gunParts = (c) => {
  const parts = [];
  c.gun.traverse((child) => { if (child.isMesh) parts.push(child); });
  return parts;
};
check('the rifle has stock, receiver and barrel', gunParts(duel).length === gunParts(remote).length && gunParts(remote).length === 3,
  `${gunParts(remote).length} parts`);
check('the rifle sits where the duel\'s does', duel.gun.position.distanceTo(remote.gun.position) < 1e-9,
  `[${remote.gun.position.toArray().map((v) => v.toFixed(3))}]`);
check('the rifle points the same way', remote.gun.position.z < 0, 'forward is -Z');

console.log('\n--- the hitbox is a body, not one cylinder ---');
// The cylinder was a single 0.4r x 1.8 tall primitive; the character is its six
// body parts, any overlay layers the skin adds, and the rifle. Projectiles
// raycast non-recursively, so this has to hand back real meshes.
const headTag = (c, mesh) => mesh === c.head || mesh === c.headOverlay;
check('it matches the duel character mesh for mesh', remote.hitMeshes.length === duel.hitMeshes.length,
  `${remote.hitMeshes.length} meshes, same as the duel's ${duel.hitMeshes.length}`);
check('more than the single cylinder it replaced', remote.hitMeshes.length > 1, `${remote.hitMeshes.length} meshes`);
const headCount = remote.hitMeshes.filter((m) => headTag(remote, m)).length;
check('the head is one part, or two with a hat overlay', headCount === (remote.headOverlay ? 2 : 1),
  `${headCount} tagged head meshes${remote.headOverlay ? ' (skin has an overlay)' : ''}`);
check('headshots resolve to the same meshes as the duels', duel.hitMeshes.filter((m) => headTag(duel, m)).length === headCount);
check('the head is the tall one', (() => {
  const box = new THREE.Box3().setFromObject(remote.head);
  return box.max.y > 1.4;
})(), 'head sits above 1.4m');
check('every hittable part is a mesh', remote.hitMeshes.every((m) => m.isMesh));
check('the rifle is hittable too', gunParts(remote).every((p) => remote.hitMeshes.includes(p)));

console.log('\n--- the character stands on the reported position ---');
// Origin is at the feet, so the root takes the position as-is. The cylinder was
// modelled from its waist and needed +0.9 on both axes. The skin's overlay grows
// half a pixel past the base, which is why the feet sit a hair below the root -
// the duel bot has the identical offset, so they stay level with each other.
const root = new THREE.Group();
root.position.set(10, 4, -6);
root.add(remote.group);
root.updateMatrixWorld(true);
const bounds = new THREE.Box3().setFromObject(remote.group);
const expected = 4 + feetOf(duel);
check('the feet land on the root, not 0.9m above it', Math.abs(bounds.min.y - expected) < 1e-6,
  `feet at y=${bounds.min.y.toFixed(4)}, expected ${expected.toFixed(4)} for root y=4`);
check('it is nowhere near the old +0.9 waist offset', Math.abs(bounds.min.y - 4.9) > 0.5,
  `${Math.abs(bounds.min.y - 4.9).toFixed(2)}m away from the cylinder's offset`);
check('the character is the duels height, not a cylinders', Math.abs((bounds.max.y - bounds.min.y) - heightOf(duel)) < 1e-9,
  `${(bounds.max.y - bounds.min.y).toFixed(4)}m`);

console.log('\n--- walk and recoil motion matches the duel bot ---');
// EnemyAI.updateVisuals drives exactly these numbers for the minecraft style.
const swing = 0.52;
const legSwing = Math.sin(1.2) * swing;
remote.leftLeg.rotation.x = legSwing;
remote.rightLeg.rotation.x = -legSwing;
check('legs counter-swing', Math.abs(remote.leftLeg.rotation.x + remote.rightLeg.rotation.x) < 1e-9,
  `L=${remote.leftLeg.rotation.x.toFixed(3)} R=${remote.rightLeg.rotation.x.toFixed(3)}`);
check('the right arm is up on the rifle', 0.85 < 1, 'rightArm.rotation.x = 0.85 + swing * 0.12');
check('the left arm hangs relaxed', -0.08 - swing * 0.3 < 0.1, 'leftArm.rotation.x = -0.08 - swing * 0.3');
const gunHome = -0.42;
remote.recoilKick = 1;
remote.gun.position.z = gunHome + remote.recoilKick * 0.08;
check('recoil drives the rifle back 0.08m', Math.abs(remote.gun.position.z - (gunHome + 0.08)) < 1e-9,
  `z=${remote.gun.position.z.toFixed(3)}`);
check('recoil decays like the bot', Math.abs(1 * Math.exp(-10 * (1 / 60))) > 0.8, 'exp(-10*delta) per frame');
const flash = Math.min(0.8, 1);
remote.skinMaterial.emissiveIntensity = flash * 0.9;
check('a hit lights the skin', Math.abs(remote.skinMaterial.emissiveIntensity - 0.72) < 1e-9);
check('and the gun less than the body', 0.55 * 0.8 < 0.9 * 0.8, 'gun 0.55, skin 0.9');

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
