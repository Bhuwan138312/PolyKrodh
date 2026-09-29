import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { WEAPON_MODELS } from '../config.js';
import { findWeaponReferences, hideViewmodelOnlyParts } from '../player/GLBWeaponRig.js';

/**
 * Real weapon models in a character's hands.
 *
 * The blocky character ships with a premade three-box rifle, which is fine for
 * a bot that never changes gun but wrong the moment a real player switches
 * weapons - a pistol-carrying opponent would still be holding a rifle. This
 * loads the same four GLBs the viewmodel uses and fits them for a world
 * character instead of a camera, so what an opponent holds in a match is the
 * gun they actually picked up.
 *
 * The difference from the viewmodel's fit is scale. WeaponSystem sizes its model
 * by `targetLength` and then scales the whole holder by `viewScale` because a
 * viewmodel has to read at arm's length through an 80-degree lens. A character
 * is a real 1.8m object standing in a real world, so the guns here are fitted to
 * their real lengths instead. The model rotation is the same - the barrel ends
 * up pointing down -Z, which is the direction the character faces.
 *
 * Each GLB is loaded and fitted once and cached. A player gets a clone of the
 * cached prototype with its own materials, so one player's hit flash cannot
 * light up everybody else's gun, and disposing a player never touches the
 * shared prototype.
 */

/**
 * The guns a character can hold, in the same order the player picks them.
 *
 * The model, and the size it is fitted to, are read from `WEAPON_MODELS` - the
 * same list Game.js builds the viewmodels from - so a character's gun is exactly
 * the size the player's is and cannot drift away from it. `gripFromRear` is the
 * one thing that is only meaningful here: how far up from the back of the gun
 * the hand closes, which is what puts the fist on the pistol grip rather than
 * floating under the barrel or off the end of the stock. It is a fraction of the
 * gun's length, so it follows the size automatically.
 */
const GRIP_FRACTION = Object.freeze({ M416: 0.29, Pistol: 0.28, Shotgun: 0.29, Sniper: 0.30 });

export const HELD_WEAPONS = Object.freeze(
  WEAPON_MODELS.map((model) => {
    // targetLength is the asset scaled to that length, and viewScale is the
    // holder scaled again on top of it. Together they are the size the player
    // actually sees, so that is the size a character's copy is built at.
    const length = model.targetLength * model.viewScale;
    return Object.freeze({
      key: model.key,
      displayName: model.displayName,
      url: model.modelUrl,
      targetLength: model.targetLength,
      viewScale: model.viewScale,
      length,
      // Measured in the asset's own space, which is `targetLength` long. The
      // viewmodel's holder scale is applied outside this, about the grip, so a
      // fraction of the gun lands under the hand at any size.
      gripFromRear: model.targetLength * (GRIP_FRACTION[model.key] ?? 0.29),
    });
  }).reduce((byIndex, spec, index) => {
    byIndex[index] = spec;
    return byIndex;
  }, {}),
);

/**
 * Where the gun group sits on the character, in character space. This is the
 * raised right fist: the arm pivot is at (0.3375, 1.35, 0) and the arm is
 * 0.675m long, so with the arm rotated up 0.85 rad the hand lands at
 * (0.3375, 0.9045, -0.5071). The group origin is the grip, so putting the group
 * there puts the hand on the gun.
 */
const GRIP_ANCHOR = new THREE.Vector3(0.3375, 0.9045, -0.5071);

const cache = new Map();

/**
 * Fits one loaded GLB scene for a world character.
 *
 * The rotation and the length are the viewmodel's own: `targetLength` scales the
 * asset, `viewScale` is what the viewmodel's holder adds on top, and doing the
 * same here is what makes the gun in a character's hands exactly the gun the
 * player is holding. Centred, then shifted back along +Z so the grip lands on the
 * origin.
 *
 * The model's first-person-only nodes - the loose round, the spent casing, the
 * red dot - are hidden exactly as the viewmodel hides them, from the same shared
 * list, so an opponent is not visibly carrying a bullet in the chamber that you
 * never see in your own gun.
 *
 * Returns the asset and the materials it uses, so an instance can clone them.
 */
function fitForCharacter(asset, spec) {
  asset.name = `Held${spec.key}`;
  asset.rotation.y = Math.PI / 2;
  asset.updateMatrixWorld(true);

  const raw = new THREE.Box3().setFromObject(asset);
  const rawSize = raw.getSize(new THREE.Vector3());
  asset.scale.setScalar(spec.targetLength / Math.max(rawSize.x, rawSize.z, 0.001));
  asset.updateMatrixWorld(true);

  const scaled = new THREE.Box3().setFromObject(asset);
  asset.position.sub(scaled.getCenter(new THREE.Vector3()));
  asset.updateMatrixWorld(true);

  // With the model centred, +size.z/2 is the muzzle end and -size.z/2 the back
  // of the stock. Translating by (half length - grip) leaves the grip point on
  // the origin.
  const fitted = new THREE.Box3().setFromObject(asset);
  const size = fitted.getSize(new THREE.Vector3());
  asset.position.z += size.z / 2 - spec.gripFromRear;
  asset.updateMatrixWorld(true);

  // The viewmodel's holder scale, so the gun is the size the player sees. It is
  // applied to the group the character's gun group holds, not to the asset
  // itself, because the asset's own scale is what put it at `targetLength`.
  hideViewmodelOnlyParts(findWeaponReferences(asset));

  const materials = new Set();
  const meshes = [];
  asset.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    meshes.push(child);
    if (Array.isArray(child.material)) child.material.forEach((m) => materials.add(m));
    else if (child.material) materials.add(child.material);
  });

  return { asset, materials: [...materials], meshes };
}

function loadSpec(index) {
  const spec = HELD_WEAPONS[index];
  if (!spec) return Promise.resolve(null);
  if (cache.has(index)) return cache.get(index);
  const loader = new GLTFLoader();
  const pending = new Promise((resolve) => {
    loader.load(
      spec.url,
      (gltf) => {
        try {
          cache.set(index, { ...fitForCharacter(gltf.scene, spec), spec });
        } catch (error) {
          console.warn(`Held ${spec.key} could not be fitted; the character keeps its premade gun.`, error);
          cache.set(index, null);
        }
        resolve(cache.get(index));
      },
      undefined,
      () => {
        // Non-fatal: the character simply keeps the gun the builder gave it.
        console.warn(`Held ${spec.key} failed to load; the character keeps its premade gun.`);
        cache.set(index, null);
        resolve(null);
      },
    );
  });
  return pending;
}

/**
 * Loads every gun a player can hold, in the background. Called once at boot so
 * the first opponent to be seen is already holding a real gun; not awaiting it
 * keeps a missing or slow model from holding up the menu.
 */
export function preloadHeldWeapons() {
  return Promise.all(Object.keys(HELD_WEAPONS).map((index) => loadSpec(Number(index))));
}

/** True once a given index has a real gun ready to hand out. */
export function isHeldWeaponReady(index) {
  return Boolean(cache.get(index));
}

/**
 * A private copy of the gun, ready to hang on a character.
 *
 * The clone is deep enough to own its materials, which is what keeps one
 * player's hit flash off another player's rifle. Returns null when that gun is
 * not loaded, and the caller falls back to the premade one.
 */
export function createHeldWeapon(index) {
  const entry = cache.get(index);
  if (!entry) return null;

  const group = new THREE.Group();
  group.name = `HeldWeapon${entry.spec.key}`;
  // `viewScale` is the same factor WeaponSystem puts on the viewmodel's holder,
  // so a character's gun comes out the same size as the player's rather than a
  // correctly-scaled but visibly smaller real-world one.
  group.scale.setScalar(entry.spec.viewScale);
  // Scaled about the hand, not about the world origin, so scaling up the gun
  // does not throw the grip out from under the fist.
  group.position.copy(GRIP_ANCHOR);

  const asset = entry.asset.clone(true);
  // The clone shares geometry, which is what we want - the meshes are static
  // and only ever disposed with the character. Materials are per-player.
  const materialMap = new Map();
  asset.traverse((child) => {
    if (!child.isMesh) return;
    child.castShadow = true;
    child.receiveShadow = true;
    const cloneMaterial = (source) => {
      if (!materialMap.has(source)) {
        const copy = source.clone();
        // The viewmodel's guns flash on hit via emissive; a held gun has to be
        // able to do the same without writing through to the shared prototype.
        if (copy.emissive) copy.emissive = copy.emissive.clone();
        materialMap.set(source, copy);
      }
      return materialMap.get(source);
    };
    child.material = Array.isArray(child.material)
      ? child.material.map(cloneMaterial)
      : cloneMaterial(child.material);
  });
  group.add(asset);

  const materials = [...materialMap.values()];
  // The brightest emissive contributor is what the hit flash drives, matching
  // how the premade gun has a single gunMaterial.
  const flashMaterial = materials.find((m) => m.emissive && m.emissive.getHex() !== 0) ?? materials[0] ?? null;

  return {
    group,
    asset,
    materials,
    flashMaterial,
    meshes: [],
  };
}

/**
 * Frees a gun handed out by `createHeldWeapon`. Geometry is shared with the
 * cached prototype and is never disposed here; only the per-player materials
 * this call created are.
 */
export function disposeHeldWeapon(held) {
  if (!held) return;
  (held.materials ?? []).forEach((material) => material.dispose());
}
