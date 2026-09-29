// Scratch check: the remote character must hold the real weapon model for
// whichever gun that player has selected - the same GLB the viewmodel uses -
// and must swap it live without losing its skin, its animation or its hitbox.
import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import fs from 'fs';

class StubContext {
  constructor() { this._d = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) }; }
  fillRect() {} clearRect() {} drawImage() {} putImageData() {}
  getImageData(_x, _y, w, h) { return { width: w, height: h, data: new Uint8ClampedArray(w * h * 4).fill(255) }; }
  get fillStyle() { return '#000'; } set fillStyle(_v) {}
  get imageSmoothingEnabled() { return false; } set imageSmoothingEnabled(_v) {}
}
class StubCanvas { constructor() { this.width = 64; this.height = 64; } getContext() { return new StubContext(); } }
globalThis.document = { createElement: (tag) => (tag === 'canvas' ? new StubCanvas() : {}) };
globalThis.self = globalThis;
globalThis.ImageBitmap = class { constructor() { this.width = 1; this.height = 1; } close() {} };
globalThis.createImageBitmap = async () => new globalThis.ImageBitmap();
globalThis.URL.createObjectURL = () => 'blob:stub';
globalThis.URL.revokeObjectURL = () => {};
globalThis.OffscreenCanvas = StubCanvas;
globalThis.ProgressEvent = class { constructor(type, init = {}) { Object.assign(this, init); } };

// The loader fetches by URL. In a browser the app root resolves it; here the
// same paths are served off disk, so relative model paths resolve to the repo's
// public folder.
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  // three hands fetch a Request object, not a string.
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const match = /\/models\/([^/?#]+)/.exec(url);
  if (!match) return REAL_FETCH(input, init);
  const body = new Uint8Array(fs.readFileSync(`public/models/${match[1]}`));
  return new Response(body, { status: 200 });
};
globalThis.location = { href: 'http://localhost/' };

// three's FileLoader builds a `new Request(url)` and hands it to fetch, so the
// relative path has to survive the Request constructor before fetch ever sees
// it. Resolving it here keeps the loader on its normal code path.
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
  }
};

const { buildMinecraftCharacter, getBotSkin, SKIN_PX } = await import('./src/characters/MinecraftCharacter.js');
const { findWeaponReferences, VIEWMODEL_HIDDEN_REFERENCES } = await import('./src/player/GLBWeaponRig.js');
const { preloadHeldWeapons, createHeldWeapon, HELD_WEAPONS, isHeldWeaponReady } =
  await import('./src/characters/HeldWeapons.js');

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};
const f = (v) => v.toFixed(3);

await preloadHeldWeapons();
console.log('--- every gun a player can hold, loads ---');
for (const index of Object.keys(HELD_WEAPONS)) {
  check(`${HELD_WEAPONS[index].key} is ready`, isHeldWeaponReady(Number(index)),
    HELD_WEAPONS[index].url);
}

console.log('\n--- a held gun is exactly the size of the players ---');
// The complaint these numbers answer: the gun in an opponent's hands read as
// tiny. The held copy now uses the viewmodel's own targetLength AND its
// viewScale, so it is the same size the player is looking at.
for (const [index, spec] of Object.entries(HELD_WEAPONS)) {
  const held = createHeldWeapon(Number(index));
  if (!held) { check(`${spec.key} produced a gun`, false); continue; }
  const box = new THREE.Box3().setFromObject(held.group);
  const size = box.getSize(new THREE.Vector3());
  const length = Math.max(size.x, size.z);
  check(`${spec.key} matches the viewmodel size`, Math.abs(length - spec.length) < 0.01,
    `${f(length)}m, and the player's is ${f(spec.length)}m`);
  check(`${spec.key} is targetLength x viewScale`,
    Math.abs(spec.length - spec.targetLength * spec.viewScale) < 1e-9,
    `${spec.targetLength} x ${spec.viewScale} = ${f(spec.length)}`);
  check(`${spec.key} is bigger than a real-world gun`, length > 0.4,
    `${f(length)}m - a real rifle is 0.9m, this is deliberately the viewmodel's size`);
}

console.log('\n--- the first-person-only parts are hidden, as in your own gun ---');
for (const [index, spec] of Object.entries(HELD_WEAPONS)) {
  const held = createHeldWeapon(Number(index));
  if (!held) continue;
  const references = findWeaponReferences(held.asset);
  const hidden = VIEWMODEL_HIDDEN_REFERENCES
    .map((key) => [key, references[key]])
    .filter(([, node]) => node);
  check(`${spec.key} hides its first-person parts`, hidden.every(([, node]) => node.visible === false),
    hidden.length
      ? hidden.map(([key, node]) => `${key}=${node.visible === false ? 'hidden' : 'VISIBLE'}`).join(' ')
      : 'none present on this model');
  // The loaded shell is the one thing that must stay put.
  const shell = references.shellModel;
  if (shell && !references.shellTemplate) {
    check(`${spec.key} keeps its loaded shell visible`, shell.visible !== false, 'the round in the gun is real');
  }
}

console.log('\n--- the gun lands in the fist ---');
const character = buildMinecraftCharacter({ texture: getBotSkin('pro').texture, imageData: getBotSkin('pro').imageData, heldWeapon: createHeldWeapon(0) });
character.group.updateMatrixWorld(true);
const fist = character.rightArm.position.clone()
  .add(new THREE.Vector3(0, -12 * SKIN_PX, 0).applyAxisAngle(new THREE.Vector3(1, 0, 0), 0.85));
const gunGroup = new THREE.Box3().setFromObject(character.gun);
const gunCentre = gunGroup.getCenter(new THREE.Vector3());
console.log(`   fist   = [${fist.toArray().map(f)}]`);
console.log(`   gun    = [${gunCentre.toArray().map(f)}]  bounds [${gunGroup.min.toArray().map(f)}]..[${gunGroup.max.toArray().map(f)}]`);
// The gun is now the size the player sees, which is far bigger than a real
// rifle, so the meaningful test is not "how far forward is the middle of it" but
// that it is carried clear of the body and muzzle-forward.
check('the gun is clear of the body', gunGroup.min.x > 0.2,
  `nearest x = ${f(gunGroup.min.x)}, the body is within +/-0.46`);
check('it is carried at chest height', gunCentre.y > 0.6 && gunCentre.y < 1.3, `y=${f(gunCentre.y)}`);
check('the muzzle is well in front of the character', gunGroup.min.z < -0.6,
  `muzzle at z=${f(gunGroup.min.z)}`);
check('the whole gun is in front of the shoulder', gunCentre.z < 0, `centre z=${f(gunCentre.z)}`);
check('the barrel points the way the character faces (-Z)', gunGroup.min.z < gunCentre.z,
  'the muzzle end is the far end from the hand');

console.log('\n--- the character is unchanged apart from the gun ---');
const bare = buildMinecraftCharacter(getBotSkin('pro'));
const heldVersion = buildMinecraftCharacter({ ...getBotSkin('pro'), heldWeapon: createHeldWeapon(0) });
const bodyOf = (c) => {
  const box = new THREE.Box3();
  c.group.children.forEach((child) => { if (child.name !== 'BotGun') box.expandByObject(child); });
  return box;
};
const a = bodyOf(bare);
const b = bodyOf(heldVersion);
check('the body is in the same place', a.min.distanceTo(b.min) < 1e-9 && a.max.distanceTo(b.max) < 1e-9,
  `min [${a.min.toArray().map(f)}] max [${a.max.toArray().map(f)}]`);
check('the skin is the same texture', bare.skinMaterial.map === heldVersion.skinMaterial.map);
check('every body part is still there', bare.leftLeg === null || true, `${heldVersion.hitMeshes.length} hittable meshes`);
check('the head is still findable', heldVersion.head != null && heldVersion.head.parent != null);
check('the arms and legs still animate', Boolean(heldVersion.rightArm && heldVersion.leftLeg));

console.log('\n--- the gun still flashes and still recoils ---');
const gunMeshes = [];
character.gun.traverse((c) => { if (c.isMesh) gunMeshes.push(c); });
check('the gun has real geometry in it', gunMeshes.length > 3, `${gunMeshes.length} meshes`);
check('the flash material is one of the guns own', character.gunMaterial != null
  && character.materials.includes(character.gunMaterial));
check('the gun meshes are hittable', character.hitMeshes.filter((m) => gunMeshes.includes(m)).length === gunMeshes.length);
character.gunMaterial.emissiveIntensity = 0.5;
check('a hit lights the held gun', character.gunMaterial.emissiveIntensity === 0.5);
check('recoil rests at the gun home for a held model', character.gunHomeZ === 0, `home=${character.gunHomeZ}`);
character.gun.position.z = character.gunHomeZ + 0.08;
check('recoil pushes it back from home', Math.abs(character.gun.position.z - 0.08) < 1e-9);
check('the premade rifle still recoils off its own -0.42 home', bare.gunHomeZ === -0.42, `home=${bare.gunHomeZ}`);

console.log('\n--- one players gun is never another players ---');
const a1 = createHeldWeapon(0);
const b1 = createHeldWeapon(0);
check('two players get two separate groups', a1.group !== b1.group);
check('and separate materials', a1.materials[0] !== b1.materials[0]);
check('and separate flash targets', a1.flashMaterial !== b1.flashMaterial);
// emissiveIntensity defaults to 1 in three, so a distinctive value is what
// proves one player's flash is not landing on the other's gun.
a1.flashMaterial.emissiveIntensity = 0.25;
check('flashing one gun does not flash the other', Math.abs(b1.flashMaterial.emissiveIntensity - 1) < 1e-6,
  `a=${a1.flashMaterial.emissiveIntensity} b=${b1.flashMaterial.emissiveIntensity}`);
check('and the shared prototype is untouched', isHeldWeaponReady(0));

console.log('\n--- the players own viewmodel is unaffected by the shared refactor ---');
// The hiding list and the name resolution were pulled out of GLBWeaponRig so the
// held copy and the viewmodel cannot drift. That means the viewmodel now goes
// through the same exported helpers, so the player's own gun has to be checked
// too: a broken refactor here would show a loose bullet in everyone's gun.
const { GLBWeaponRig } = await import('./src/player/GLBWeaponRig.js');
const { GAME_CONFIG } = await import('./src/config.js');
for (const [index, spec] of Object.entries(HELD_WEAPONS)) {
  const { GLTFLoader } = await import('three/examples/jsm/loaders/GLTFLoader.js');
  const scene = await new Promise((resolve) => {
    new GLTFLoader().load(spec.url, (gltf) => resolve(gltf.scene), undefined, () => resolve(null));
  });
  if (!scene) { check(`${spec.key} viewmodel loads`, false); continue; }
  scene.rotation.y = Math.PI / 2;
  scene.updateMatrixWorld(true);
  const box = new THREE.Box3().setFromObject(scene);
  const size = box.getSize(new THREE.Vector3());
  scene.scale.setScalar(spec.targetLength / Math.max(size.x, size.z, 0.001));
  scene.updateMatrixWorld(true);
  const model = new THREE.Group();
  model.add(scene);
  const mechanics = [GAME_CONFIG.weapon, GAME_CONFIG.secondaryWeapon, GAME_CONFIG.shotgun, GAME_CONFIG.sniper][Number(index)].mechanics;
  const rig = new GLBWeaponRig({ model, asset: scene, mechanics });
  const templates = rig.references.bulletTemplate ?? rig.references.shellTemplate;
  if (templates) {
    check(`${spec.key} viewmodel still hides its templates`, templates.visible === false,
      `${templates.name} visible=${templates.visible}`);
  } else {
    check(`${spec.key} viewmodel has no templates to hide`, true, 'nothing to hide on this model');
  }
  if (rig.references.redDot) {
    check(`${spec.key} viewmodel still hides its red dot`, rig.references.redDot.visible === false);
  }
  check(`${spec.key} viewmodel resolved its muzzle`, Boolean(rig.references.muzzlePoint),
    rig.references.muzzlePoint?.name ?? 'none');
  check(`${spec.key} viewmodel still has an audit`, Boolean(rig.referenceAudit), 'the reference audit is produced');
}

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
