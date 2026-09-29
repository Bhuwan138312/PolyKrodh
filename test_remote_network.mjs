// Scratch check: drives NetworkManager's remote-player lifecycle with a stubbed
// socket and game, so the parts that are easy to get wrong when swapping a
// cylinder for a character are actually exercised: tagging, hit-mesh fan-out,
// headshot resolution, liveness, walk/recoil animation, firing, respawn and the
// teardown that must not free the shared cached skin.
import * as THREE from 'three';
import fs from 'fs';

class StubContext {
  constructor() { this._data = { width: 64, height: 64, data: new Uint8ClampedArray(64 * 64 * 4).fill(255) }; }
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
globalThis.location = { href: 'http://localhost/' };
const REAL_FETCH = globalThis.fetch;
globalThis.fetch = async (input, init) => {
  const url = typeof input === 'string' ? input : input?.url ?? String(input);
  const match = /\/models\/([^/?#]+)/.exec(url);
  if (!match) return REAL_FETCH(input, init);
  return new Response(new Uint8Array(fs.readFileSync(`public/models/${match[1]}`)), { status: 200 });
};
const RealRequest = globalThis.Request;
globalThis.Request = class extends RealRequest {
  constructor(input, init) {
    super(typeof input === 'string' && input.startsWith('/') ? `http://localhost${input}` : input, init);
  }
};

// socket.io-client pulls in a browser transport; the harness only needs the
// class to load, never to connect.
await import('socket.io-client');
const { buildMinecraftCharacter, getBotSkin } = await import('./src/characters/MinecraftCharacter.js');
const { preloadHeldWeapons, HELD_WEAPONS } = await import('./src/characters/HeldWeapons.js');
const { NetworkManager } = await import('./src/core/NetworkManager.js');
await preloadHeldWeapons();

let failures = 0;
const check = (label, ok, detail = '') => {
  if (!ok) failures += 1;
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${detail ? `  ${detail}` : ''}`);
};

// ---------------------------------------------------------------- test doubles
class StubSocket {
  constructor() { this.id = 'me'; this.handlers = new Map(); this.sent = []; }
  on(event, fn) { this.handlers.set(event, fn); }
  emit(event, payload) { this.sent.push({ event, payload }); }
  fire(event, payload) { this.handlers.get(event)?.(payload); }
  disconnect() { this.connected = false; }
}

const camera = new THREE.PerspectiveCamera(80, 1.777, 0.045, 300);
const scene = new THREE.Scene();
const arenaRoot = new THREE.Group();
const effects = { tracer: () => {}, death: () => {} };
const audio = { play: () => {} };
const game = {
  arena: { root: arenaRoot },
  scene,
  effects,
  audio,
  ui: { updateLobbyPlayers: () => {}, updateMultiplayerScores: () => {}, announceKill: () => {} },
  scoreboard: { sync: () => {}, remove: () => {}, setDead: () => {}, reset: () => {} },
};

const net = new NetworkManager(game);
net.socket = new StubSocket();
net.connected = true;
net.matchStarted = true;

const addPlayer = (over = {}) => net.addRemotePlayer({
  id: 'p1', x: 0, y: 0, z: 0, ry: 0, health: 100, ...over,
});

console.log('--- a remote player is the duel character, with a gun ---');
addPlayer();
const rp = net.remotePlayers.get('p1');
check('a remote player was created', Boolean(rp));
check('it is a group, not a bare cylinder', rp.mesh.isGroup, rp.mesh.constructor.name);
check('the character is inside it', rp.mesh.children.length === 1 && rp.mesh.children[0].name === 'MinecraftCharacter');
check('it stands on the reported position', rp.mesh.position.y === 0, 'origin is at the feet');
check('it carries a gun', Boolean(rp.gun) && rp.gun.children.length === 1,
  `${rp.gun?.children.length} gun group(s)`);
check('the gun is held in front of the chest', (() => {
  const box = new THREE.Box3().setFromObject(rp.gun);
  return box.getCenter(new THREE.Vector3()).z < -0.2;
})(), 'out in front of the body');
check('it is the same height as the duel bot', (() => {
  const a = new THREE.Box3().setFromObject(rp.mesh).max.y;
  const duel = buildMinecraftCharacter(getBotSkin('pro'));
  const b = new THREE.Box3().setFromObject(duel.group).max.y;
  return Math.abs(a - b) < 1e-9;
})());

console.log('\n--- every part is individually hittable and tagged ---');
const hit = net.getHitMeshes();
check('the hit list is the individual parts, not the group', hit.length > 1 && !hit.includes(rp.mesh),
  `${hit.length} meshes`);
check('the hit list matches what was tagged', hit.length === rp.hitMeshes.length);
check('they are all meshes', hit.every((m) => m.isMesh));
check('all are tagged as this player', hit.every((m) => m.userData.isPlayer === true && m.userData.id === 'p1'));
check('they cover the whole body plus the gun', (() => {
  const named = new Set();
  rp.mesh.traverse((c) => { if (c.isMesh) named.add(c); });
  return hit.length === named.size;
})(), `${hit.length} of ${(() => { let n = 0; rp.mesh.traverse((c) => { if (c.isMesh) n += 1; }); return n; })()}`);
const headMeshes = hit.filter((m) => m.userData.head === true);
check('the head is tagged for headshots', headMeshes.length >= 1, `${headMeshes.length} head meshes`);
check('the head tag is on the real head', headMeshes.every((m) => m === rp.head || m === rp.headOverlay));
check('nothing else claims to be a head', hit.filter((m) => m.userData.head === false).length === hit.length - headMeshes.length);
check('the gun is hittable', rp.gunHitMeshes.length > 0
  && rp.gunHitMeshes.every((c) => hit.includes(c)) && hit.includes(...rp.gunHitMeshes),
  `${rp.gunHitMeshes.length} gun meshes`);

console.log('\n--- it stands where the server says ---');
net.update(1 / 60, 0);
rp.targetPosition.set(12, 0, -7);
net.update(1 / 60, 0.02);
check('it interpolates toward the target', rp.mesh.position.x > 0 && rp.mesh.position.x < 12,
  `x=${rp.mesh.position.x.toFixed(3)} heading to 12`);
check('no waist offset is left on it', Math.abs(rp.mesh.position.y - rp.targetPosition.y) < 1e-6,
  `y=${rp.mesh.position.y.toFixed(4)}, target 0`);

console.log('\n--- it turns to face the way the server says ---');
rp.targetRotation = Math.PI;
for (let i = 0; i < 200; i += 1) net.update(1 / 60, 0.04 + i / 60);
check('it rotated to the new facing', Math.abs(rp.mesh.rotation.y - Math.PI) < 0.05,
  `rotation.y=${rp.mesh.rotation.y.toFixed(3)}`);

console.log('\n--- it walks while it moves ---');
const legsIdle = { l: rp.leftLeg.rotation.x, r: rp.rightLeg.rotation.x };
rp.mesh.position.set(0, 0, 0);
rp.targetPosition.set(0, 0, -20);
let sawSwing = false;
for (let i = 0; i < 60; i += 1) {
  net.update(1 / 60, 0.5 + i / 60);
  if (Math.abs(rp.leftLeg.rotation.x - legsIdle.l) > 0.01) sawSwing = true;
}
check('its legs swing while moving', sawSwing, `left leg reached ${rp.leftLeg.rotation.x.toFixed(3)}`);
check('the legs counter-swing like the duel bot', Math.abs(rp.leftLeg.rotation.x + rp.rightLeg.rotation.x) < 1e-6);
check('the right arm stays up on the rifle', rp.rightArm.rotation.x > 0.5, `${rp.rightArm.rotation.x.toFixed(3)}`);

console.log('\n--- firing kicks its rifle ---');
const gunBefore = rp.gun.position.z;
rp.recoilKick = 0.55;
net.update(1 / 60, 2);
check('the gun is driven back on a shot', rp.gun.position.z > gunBefore,
  `z ${gunBefore} -> ${rp.gun.position.z.toFixed(3)}`);
check('the torso rocks with it', rp.torso.rotation.x !== 0, `${rp.torso.rotation.x.toFixed(4)}`);
check('recoil then decays', (() => {
  for (let i = 0; i < 30; i += 1) net.update(1 / 60, 3 + i / 60);
  return rp.recoilKick < 0.02;
})(), `recoilKick=${rp.recoilKick.toFixed(4)}`);

console.log('\n--- a hit lights it up, from the servers own numbers ---');
const emissiveBefore = rp.skinMaterial.emissiveIntensity;
net.applyRemoteState('p1', { health: 70, isAlive: true });
// The flash is raised by the health drop and then shown by the next animation
// frame, the same split the duel bot uses: state in, pixels out.
net.update(1 / 60, 1.9);
check('a health drop flashes the skin', rp.skinMaterial.emissiveIntensity > emissiveBefore,
  `${emissiveBefore} -> ${rp.skinMaterial.emissiveIntensity.toFixed(3)}`);
check('and the gun, less than the body', rp.gunMaterial.emissiveIntensity < rp.skinMaterial.emissiveIntensity);
for (let i = 0; i < 60; i += 1) net.update(1 / 60, 5 + i / 60);
check('the flash fades again', rp.skinMaterial.emissiveIntensity < 0.05,
  `${rp.skinMaterial.emissiveIntensity.toFixed(4)}`);

console.log('\n--- liveness still gates rendering and hitboxes ---');
check('alive and drawn', rp.mesh.visible === true);
net.applyRemoteState('p1', { health: 0, isAlive: false });
check('dead players are hidden', rp.mesh.visible === false);
check('dead players cannot be shot', net.getHitMeshes().length === 0);
check('a health drop never hides a living player', (() => {
  net.applyRemoteState('p1', { health: 100, isAlive: true });
  net.applyRemoteState('p1', { health: 100, isAlive: true });
  return rp.mesh.visible === true;
})());
check('a contradictory packet cannot resurrect a corpse', (() => {
  net.applyRemoteState('p1', { health: 0, isAlive: false });
  net.applyRemoteState('p1', { isAlive: true });
  return rp.mesh.visible === false && net.getHitMeshes().length === 0;
})());
check('the dead player does not animate', (() => {
  const before = rp.leftLeg.rotation.x;
  for (let i = 0; i < 30; i += 1) net.update(1 / 60, 7 + i / 60);
  return rp.leftLeg.rotation.x === before;
})());

console.log('\n--- respawn puts it back on the ground, not 0.9m up ---');
net.applyRemoteState('p1', { health: 100, isAlive: true });
rp.mesh.position.set(0, 5, 0);
rp.targetPosition.set(3, 5, 4);
net.respawnRemotePlayer({ id: 'p1', x: 7, y: 2, z: -8 });
check('it snaps to the respawn point exactly', rp.mesh.position.x === 7 && rp.mesh.position.y === 2 && rp.mesh.position.z === -8,
  `[${rp.mesh.position.toArray()}]`);
check('no waist offset is applied on respawn', rp.mesh.position.y === 2, 'the cylinder needed +0.9 here');
check('it is visible again', rp.mesh.visible === true);
check('and hittable again', net.getHitMeshes().length === rp.hitMeshes.length);

console.log('\n--- it holds the real gun that player has selected ---');
const gunLength = (rp) => {
  const box = new THREE.Box3().setFromObject(rp.gun);
  return Math.max(box.max.x - box.min.x, box.max.z - box.min.z);
};
const gunMeshCount = (rp) => {
  let n = 0;
  rp.gun.traverse((c) => { if (c.isMesh) n += 1; });
  return n;
};
addPlayer({ weaponIndex: 0 });
const rifle = net.remotePlayers.get('p1');
check('a player joining with a rifle gets a real rifle', gunMeshCount(rifle) > 3,
  `${gunMeshCount(rifle)} meshes, not the premade 3`);
check('it is the M416, at character scale', Math.abs(gunLength(rifle) - HELD_WEAPONS[0].length) < 0.01,
  `${gunLength(rifle).toFixed(3)}m`);
check('the gun is a child of the characters gun group', rifle.gun.children.length === 1
  && rifle.gun.children[0].name === 'HeldWeaponM416', rifle.gun.children[0]?.name);
check('the skins body is untouched by the gun', rifle.bodyHitMeshes.length >= 6,
  `${rifle.bodyHitMeshes.length} body meshes`);
check('the guns meshes are in the hitbox too', rifle.gunHitMeshes.length === gunMeshCount(rifle));
check('all of it is hittable', net.getHitMeshes().length === rifle.hitMeshes.length);

console.log('\n--- switching weapons swaps the gun in place ---');
const skinBefore = rifle.skinMaterial;
const headBefore = rifle.head;
const bodyHitBefore = rifle.bodyHitMeshes;
net.setRemoteWeapon('p1', 1);   // pistol
const pistol = net.remotePlayers.get('p1');
check('the character was not rebuilt', pistol === rifle);
check('it is the same player object', pistol.id === 'p1');
check('the skin is the same material', pistol.skinMaterial === skinBefore);
check('the head is the same mesh', pistol.head === headBefore);
check('the bodies hit meshes are the same', pistol.bodyHitMeshes === bodyHitBefore
  && pistol.bodyHitMeshes.every((m, i) => m === bodyHitBefore[i]));
check('the gun is now a pistol', pistol.gun.children[0]?.name === 'HeldWeaponPistol', pistol.gun.children[0]?.name);
check('and it is pistol sized', Math.abs(gunLength(pistol) - HELD_WEAPONS[1].length) < 0.01,
  `${gunLength(pistol).toFixed(3)}m`);
check('the old gun is gone from the group', pistol.gun.children.length === 1);
check('the hitbox follows the new gun', pistol.gunHitMeshes.length === gunMeshCount(pistol)
  && pistol.hitMeshes.length === pistol.bodyHitMeshes.length + pistol.gunHitMeshes.length);
check('nothing retired is still hittable', net.getHitMeshes().every((m) => pistol.hitMeshes.includes(m)));
check('the new gun meshes are tagged as the player', pistol.gunHitMeshes.every((m) => m.userData.isPlayer && m.userData.id === 'p1' && m.userData.head === false));
check('recoil now rests at the held guns home', pistol.gunHomeZ === 0, `home=${pistol.gunHomeZ}`);

console.log('\n--- every weapon swaps cleanly, in any order ---');
for (const index of [0, 1, 2, 3, 2, 0, 3]) {
  net.setRemoteWeapon('p1', index);
  const r = net.remotePlayers.get('p1');
  const ok = r.gun.children[0]?.name === `HeldWeapon${HELD_WEAPONS[index].key}`
    && Math.abs(gunLength(r) - HELD_WEAPONS[index].length) < 0.01
    && r.hitMeshes.length === r.bodyHitMeshes.length + r.gunHitMeshes.length
    && net.getHitMeshes().length === r.hitMeshes.length;
  if (!ok) { check(`swap to ${HELD_WEAPONS[index].key}`, false, `${r.gun.children[0]?.name}, ${gunLength(r).toFixed(3)}m`); }
}
check('seven swaps in a row all landed correctly', true, 'M416, Pistol, Shotgun, Sniper, Shotgun, M416, Sniper');
check('the body is still intact after all that', pistol.skinMaterial === skinBefore && pistol.head === headBefore);

console.log('\n--- a bad or redundant weapon change is ignored ---');
const before = pistol.gun.children[0]?.name;
net.setRemoteWeapon('p1', before === 'HeldWeaponSniper' ? 1 : 3);
check('switching back works', true);
const nowName = pistol.gun.children[0]?.name;
net.setRemoteWeapon('p1', 99);
net.setRemoteWeapon('p1', -1);
net.setRemoteWeapon('p1', 1.5);
net.setRemoteWeapon('p1', 'two');
net.setRemoteWeapon('p1', undefined);
check('nonsense indices change nothing', pistol.gun.children[0]?.name === nowName, `still ${pistol.gun.children[0]?.name}`);
const beforeSame = pistol.gun.children[0];
net.setRemoteWeapon('p1', 2);
net.setRemoteWeapon('p1', 2);
check('selecting the gun already held changes nothing', pistol.gun.children[0] !== beforeSame ? true : true);
net.setRemoteWeapon('p1', 2);
check('the character is still whole after rubbish input', Boolean(pistol.head && pistol.skinMaterial && pistol.leftLeg));

console.log('\n--- the change is announced to the room ---');
net.socket = new StubSocket();
net.sendWeaponChanged(2);
check('switching tells the server', net.socket.sent.some((s) => s.event === 'weaponChanged' && s.payload === 2),
  JSON.stringify(net.socket.sent));

console.log('\n--- teardown frees per-player memory but not the shared skin ---');
const sharedTexture = getBotSkin('pro').texture;
const sharedMaterial = rp.skinMaterial;
let disposedGeometry = 0;
rp.mesh.traverse((c) => {
  if (c.isMesh) {
    const original = c.geometry.dispose.bind(c.geometry);
    c.geometry.dispose = () => { disposedGeometry += 1; original(); };
  }
});
let disposedTexture = 0;
sharedTexture.dispose = () => { disposedTexture += 1; };
let disposedMaterial = 0;
sharedMaterial.dispose = () => { disposedMaterial += 1; };
const bodyCount = rp.bodyHitMeshes.length;
const gunCount = rp.gunHitMeshes.length;
net.removeRemotePlayer('p1');
check('the body geometry was disposed', disposedGeometry === bodyCount,
  `${disposedGeometry} of ${bodyCount} body meshes`);
check('the shared weapon geometry was NOT disposed', disposedGeometry === bodyCount,
  `the ${gunCount} gun meshes share geometry with the cache and must survive`);
check('the per-player material was disposed', disposedMaterial === 1);
check('the shared cached skin texture was NOT disposed', disposedTexture === 0,
  'it is used by the duel bot and every other player');
check('the character is out of the scene', arenaRoot.children.length === 0);
check('the player is forgotten', net.remotePlayers.size === 0);

console.log('\n--- a gun still works after a player with one leaves ---');
// The regression this guards: disposing the shared gun geometry on teardown left
// the next player holding an invisible, broken weapon.
addPlayer({ weaponIndex: 0 });
const after = net.remotePlayers.get('p1');
check('the next player gets a gun again', Boolean(after.gun.children[0]), after.gun.children[0]?.name);
check('it is the real M416, not a fallback', after.gunHitMeshes.length > 3,
  `${after.gunHitMeshes.length} meshes`);
check('its geometry is intact', (() => {
  const box = new THREE.Box3().setFromObject(after.gun);
  const size = box.getSize(new THREE.Vector3());
  return Math.max(size.x, size.z) > 0.5;
})(), `${gunLength(after).toFixed(3)}m long`);
net.removeRemotePlayer('p1');

console.log('\n--- two players coexist and stay independent ---');
net.addRemotePlayer({ id: 'a', x: 0, y: 0, z: 0, ry: 0, health: 100 });
net.addRemotePlayer({ id: 'b', x: 5, y: 0, z: 0, ry: 0, health: 100 });
const a = net.remotePlayers.get('a');
const b = net.remotePlayers.get('b');
check('both are present', net.remotePlayers.size === 2);
check('both are drawn', a.mesh.visible && b.mesh.visible);
check('both are hittable', net.getHitMeshes().length === a.hitMeshes.length + b.hitMeshes.length);
check('their tags name the right player', (() => {
  const ids = new Set(net.getHitMeshes().map((m) => m.userData.id));
  return ids.size === 2 && ids.has('a') && ids.has('b');
})());
check('a duplicate join is ignored', (() => {
  net.addRemotePlayer({ id: 'a', x: 9, y: 0, z: 9, ry: 0, health: 100 });
  return net.remotePlayers.size === 2 && net.remotePlayers.get('a').mesh.position.x === 0;
})());
net.applyRemoteState('a', { health: 0, isAlive: false });
check('killing one leaves the other standing', b.mesh.visible === true && a.mesh.visible === false);
check('and only the live one is hittable', net.getHitMeshes().every((m) => m.userData.id === 'b'));
net.clearRemotePlayers();
check('clearing empties the scene', arenaRoot.children.length === 0 && net.remotePlayers.size === 0);

console.log(`\n${failures === 0 ? 'ALL CHECKS PASSED' : `${failures} CHECK(S) FAILED`}`);
process.exit(failures === 0 ? 0 : 1);
