import * as THREE from 'three';
import { BOT_TYPES } from '../config.js';

/**
 * Minecraft-style blocky character (head/torso/arms/legs) with the standard
 * 64×64 player-skin UV layout.
 *
 * Texture layout (identical to skinview3d's `src/model.ts`, the NameMC
 * preview reference):
 *   - Base regions: head (0,0,8,8,8), body (16,16,8,12,4),
 *     rightArm (40,16,4,12,4), rightLeg (0,16,4,12,4),
 *     leftArm (32,48,4,12,4), leftLeg (16,48,4,12,4)
 *   - Overlay regions start at head (32,0), body (16,32), rightArm (40,32),
 *     rightLeg (0,32), leftArm (48,48), leftLeg (0,48) with the same
 *     w/h/d as their base region.
 *   - Each part's six faces are cut from strips around the region rect:
 *     left x[u,u+d), front x[u+d,u+w+d), right x[u+w+d,u+w+2d),
 *     back x[u+w+2d,u+2w+2d), all y[v+d,v+d+h);
 *     top x[u+d,u+w+d)×y[v,v+d); bottom x[u+w+d,u+2w+d)×y[v,v+d).
 *
 * UV orientation mirrors three's BoxGeometry vertex order. With flipY=false
 * (v0 = top row of the image) each face samples its rect as
 * [TL,TR,BL,BR] per vertex, except the bottom face (ny) which is rotated
 * 180° ([BL,BR,TL,TR]) — Minecraft's long-standing bottom-face quirk.
 *
 * One skin pixel = 0.05625 m so a 32 px tall character is 1.8 m tall.
 */

export const SKIN_PX = 0.05625;
export const SKIN_WIDTH = 64;
export const SKIN_HEIGHT = 64;

export const SKIN_REGIONS = Object.freeze({
  head:     { u: 0,  v: 0,  w: 8,  h: 8,  d: 8 },
  body:     { u: 16, v: 16, w: 8,  h: 12, d: 4 },
  rightArm: { u: 40, v: 16, w: 4,  h: 12, d: 4 },
  rightLeg: { u: 0,  v: 16, w: 4,  h: 12, d: 4 },
  leftArm:  { u: 32, v: 48, w: 4,  h: 12, d: 4 },
  leftLeg:  { u: 16, v: 48, w: 4,  h: 12, d: 4 },
});

export const SKIN_OVERLAYS = Object.freeze({
  head:     { u: 32, v: 0 },
  body:     { u: 16, v: 32 },
  rightArm: { u: 40, v: 32 },
  rightLeg: { u: 0,  v: 32 },
  leftArm:  { u: 48, v: 48 },
  leftLeg:  { u: 0,  v: 48 },
});

/**
 * Body proportions (in skin pixels) and placement (in meters).
 * Character faces -Z; +X is the character's right side.
 * Arms/legs pivot groups sit at the shoulder/hip; the box offset hangs the
 * mesh from the joint so rotation swings the limb around the joint.
 */
const PART_DEFS = Object.freeze({
  head:     { size: [8, 8, 8],  center: [0, 1.575, 0],  pivot: null,   meshOffset: null,     overlayGrow: 1 },
  body:     { size: [8, 12, 4], center: [0, 1.0125, 0], pivot: null,   meshOffset: null,     overlayGrow: 0.5 },
  rightArm: { size: [4, 12, 4], center: null,           pivot: [0.3375, 1.35, 0],  meshOffset: [0, -0.3375, 0], overlayGrow: 0.5 },
  leftArm:  { size: [4, 12, 4], center: null,           pivot: [-0.3375, 1.35, 0], meshOffset: [0, -0.3375, 0], overlayGrow: 0.5 },
  rightLeg: { size: [4, 12, 4], center: null,           pivot: [0.1125, 0.675, 0], meshOffset: [0, -0.3375, 0], overlayGrow: 0.5 },
  leftLeg:  { size: [4, 12, 4], center: null,           pivot: [-0.1125, 0.675, 0], meshOffset: [0, -0.3375, 0], overlayGrow: 0.5 },
});

const FACE_NAMES = ['px', 'nx', 'py', 'ny', 'pz', 'nz'];
// Per-vertex (C1..C4) rect corner for each BoxGeometry face, in three's
// vertex order. All faces sample [TL,TR,BL,BR] except the bottom face (ny),
// which is rotated 180°.
const UV_SLOT_ORDER = Object.freeze({
  px: ['tl', 'tr', 'bl', 'br'],
  nx: ['tl', 'tr', 'bl', 'br'],
  py: ['tl', 'tr', 'bl', 'br'],
  ny: ['bl', 'br', 'tl', 'tr'],
  pz: ['tl', 'tr', 'bl', 'br'],
  nz: ['tl', 'tr', 'bl', 'br'],
});

function cssRect(x, y, w, h) {
  return { x, y, w, h };
}

/**
 * The six face rectangles of a region on the 64×64 texture (in pixels,
 * top-left origin). Keys match BoxGeometry face names.
 */
export function faceRects(region) {
  const { u, v, w, h, d } = region;
  return {
    px: cssRect(u + w + d, v + d, d, h),              // right face  (+X)
    nx: cssRect(u, v + d, d, h),                      // left face   (-X)
    py: cssRect(u + d, v, w, d),                      // top face    (+Y)
    ny: cssRect(u + w + d, v, w, d),                  // bottom face (-Y)
    pz: cssRect(u + w + 2 * d, v + d, w, h),          // back face   (+Z)
    nz: cssRect(u + d, v + d, w, h),                  // front face  (-Z)
  };
}

/**
 * Bounding box (in pixels) of all six face rectangles of a region.
 */
export function regionBounds(region) {
  return cssRect(region.u, region.v, 2 * region.w + 2 * region.d, region.d + region.h);
}

export function overlayRegion(key) {
  const base = SKIN_REGIONS[key];
  const overlay = SKIN_OVERLAYS[key];
  return { u: overlay.u, v: overlay.v, w: base.w, h: base.h, d: base.d };
}

/**
 * Replaces a BoxGeometry's default per-face UVs with per-face rect sampling.
 * Expects a 1×1×1-segment box (24 uv entries, 6 faces × 4 vertices).
 */
export function rewriteBoxUVs(geometry, rects, textureWidth = SKIN_WIDTH, textureHeight = SKIN_HEIGHT) {
  const uv = geometry.attributes.uv;
  if (uv.count !== 24) {
    throw new Error(`rewriteBoxUVs expects a 1-segment box (24 UVs), got ${uv.count}`);
  }
  for (let face = 0; face < 6; face++) {
    const r = rects[FACE_NAMES[face]];
    const corners = {
      tl: [r.x / textureWidth, r.y / textureHeight],
      tr: [(r.x + r.w) / textureWidth, r.y / textureHeight],
      bl: [r.x / textureWidth, (r.y + r.h) / textureHeight],
      br: [(r.x + r.w) / textureWidth, (r.y + r.h) / textureHeight],
    };
    const order = UV_SLOT_ORDER[FACE_NAMES[face]];
    for (let k = 0; k < 4; k++) {
      const [cu, cv] = corners[order[k]];
      uv.setXY(face * 4 + k, cu, cv);
    }
  }
  uv.needsUpdate = true;
  return geometry;
}

/* ------------------------------------------------------------------ *
 * Skins
 * ------------------------------------------------------------------ */

function hexToRgb(color) {
  return { r: (color >> 16) & 0xff, g: (color >> 8) & 0xff, b: color & 0xff };
}

function shade({ r, g, b }, amount) {
  const mix = (c) => (amount >= 0 ? Math.round(c + (255 - c) * amount) : Math.round(c * (1 + amount)));
  return { r: mix(r), g: mix(g), b: mix(b) };
}

function css({ r, g, b }) {
  return `rgb(${r},${g},${b})`;
}

/** Nearest-filtered CanvasTexture for crisp pixels. */
export function canvasToTexture(canvas) {
  const texture = new THREE.CanvasTexture(canvas);
  texture.magFilter = THREE.NearestFilter;
  texture.minFilter = THREE.NearestFilter;
  texture.generateMipmaps = false;
  texture.flipY = false;
  texture.colorSpace = THREE.SRGBColorSpace;
  return texture;
}

/** Reads a 64×64 ImageData from an image-ish source (canvas/image/ImageData). */
export function imageSourceToImageData(source) {
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    if (source.width === SKIN_WIDTH && source.height === SKIN_HEIGHT) return source;
  }
  const canvas = document.createElement('canvas');
  canvas.width = SKIN_WIDTH;
  canvas.height = SKIN_HEIGHT;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.imageSmoothingEnabled = false;
  if (typeof ImageData !== 'undefined' && source instanceof ImageData) {
    const temp = document.createElement('canvas');
    temp.width = source.width;
    temp.height = source.height;
    temp.getContext('2d').putImageData(source, 0, 0);
    ctx.drawImage(temp, 0, 0, SKIN_WIDTH, SKIN_HEIGHT);
  } else {
    ctx.drawImage(source, 0, 0, SKIN_WIDTH, SKIN_HEIGHT);
  }
  return ctx.getImageData(0, 0, SKIN_WIDTH, SKIN_HEIGHT);
}

function readCanvasImageData(canvas) {
  return canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, canvas.width, canvas.height);
}

export function hasOpaqueContent(imageData, rect) {
  const { data } = imageData;
  for (let y = rect.y; y < rect.y + rect.h; y++) {
    for (let x = rect.x; x < rect.x + rect.w; x++) {
      if (data[(y * imageData.width + x) * 4 + 3] > 10) return true;
    }
  }
  return false;
}

/**
 * Procedural 64×64 skin for a bot type. The body color comes from BOT_TYPES
 * and the accent color drives the vest/sleeves. Overlay regions are left
 * fully transparent so no hat boxes are created.
 */
export function paintBotSkin(typeKey) {
  const type = BOT_TYPES[typeKey] ?? BOT_TYPES.normal;
  const base = hexToRgb(type.color);
  const accent = hexToRgb(type.accent);
  const darkShade = shade(base, -0.3);
  const white = { r: 255, g: 255, b: 255 };
  const black = { r: 0, g: 0, b: 0 };

  const canvas = document.createElement('canvas');
  canvas.width = SKIN_WIDTH;
  canvas.height = SKIN_HEIGHT;
  const ctx = canvas.getContext('2d');
  ctx.imageSmoothingEnabled = false;

  function fill(rect, color) {
    ctx.fillStyle = css(color);
    ctx.fillRect(rect.x, rect.y, rect.w, rect.h);
  }

  // 1. Base color over every part's face area.
  for (const key of Object.keys(SKIN_REGIONS)) {
    fill(regionBounds(SKIN_REGIONS[key]), base);
  }

  // 2. Head. Strips y[8,16), caps y[0,8). Face F = x[8,16).
  fill({ x: 0, y: 8, w: 8, h: 8 }, darkShade);        // left strip (ear/side)
  fill({ x: 16, y: 8, w: 8, h: 8 }, darkShade);       // right strip
  fill({ x: 24, y: 8, w: 8, h: 8 }, darkShade);       // back of head
  fill({ x: 8, y: 0, w: 8, h: 8 }, shade(base, 0.1)); // top of head
  fill({ x: 16, y: 0, w: 8, h: 8 }, darkShade);       // bottom (neck) cap
  fill({ x: 8, y: 8, w: 8, h: 1 }, darkShade);        // hair fringe
  fill({ x: 8, y: 9, w: 8, h: 3 }, darkShade);        // visor band
  fill({ x: 9, y: 10, w: 2, h: 1 }, white);           // eyes
  fill({ x: 13, y: 10, w: 2, h: 1 }, white);
  fill({ x: 11, y: 14, w: 2, h: 1 }, black);          // mouth

  // 3. Body. Strips y[20,32), caps y[16,20). Front F = x[20,28).
  fill({ x: 16, y: 20, w: 4, h: 12 }, shade(base, -0.12));  // left strip
  fill({ x: 28, y: 20, w: 4, h: 12 }, shade(base, -0.12));  // right strip
  fill({ x: 32, y: 20, w: 8, h: 12 }, shade(base, -0.08));  // back strip
  fill({ x: 20, y: 16, w: 8, h: 4 }, shade(base, 0.1));     // shoulders
  fill({ x: 28, y: 16, w: 8, h: 4 }, darkShade);            // bottom cap
  fill({ x: 21, y: 22, w: 6, h: 6 }, accent);               // chest plate
  fill({ x: 20, y: 20, w: 8, h: 2 }, darkShade);            // collar
  fill({ x: 20, y: 29, w: 8, h: 2 }, darkShade);            // belt

  // 4. Arms. Side strips y[20,32) / y[52,64); caps y[16,20) / y[48,52).
  fillArm(ctx, 40, 16, 20, accent);                   // right arm AOI (40,16)
  fillArm(ctx, 32, 48, 52, accent);                   // left arm AOI (32,48)

  // 5. Legs: dark pants + boots.
  fillLeg(ctx, 0, 16, 20);                            // right leg AOI (0,16)
  fillLeg(ctx, 16, 48, 52);                           // left leg AOI (16,48)

  // 6. Guarantee every overlay region is fully transparent.
  for (const key of Object.keys(SKIN_OVERLAYS)) {
    const rect = regionBounds(overlayRegion(key));
    ctx.clearRect(rect.x, rect.y, rect.w, rect.h);
  }

  return canvas;
}

/**
 * Arm AOI is 16 px wide at (ax, ay); side strips begin at `stripsY`.
 * Paints an accent sleeve across all four side strips (8 px) over the base
 * hand coloring.
 */
function fillArm(ctx, ax, ay, stripsY, accent) {
  ctx.fillStyle = css(shade(accent, -0.1));
  ctx.fillRect(ax, stripsY, 16, 8);                   // sleeve band (L/F/R/B)
  ctx.fillRect(ax + 4, ay, 4, 4);                     // top cap
  ctx.fillStyle = css(shade(accent, -0.3));
  ctx.fillRect(ax + 8, ay, 4, 4);                     // bottom cap
}

/** Leg AOI is 16 px wide at (ax, ay); side strips begin at `stripsY`. */
function fillLeg(ctx, ax, ay, stripsY) {
  ctx.fillStyle = 'rgba(0,0,0,0.15)';                 // pants tint over the base
  ctx.fillRect(ax, stripsY, 16, 8);                   // pants (L/F/R/B strips)
  ctx.fillRect(ax + 4, ay, 4, 4);                     // top cap
  ctx.fillStyle = 'rgba(0,0,0,0.4)';                  // boots
  ctx.fillRect(ax, stripsY + 8, 16, 4);
  ctx.fillRect(ax + 8, ay, 4, 4);                     // bottom cap
}

const BOT_SKIN_CACHE = new Map();

/**
 * Cached { texture, imageData } for a bot type. The imageData drives overlay
 * detection and left-region mirror fallback.
 */
export function getBotSkin(typeKey) {
  if (!BOT_SKIN_CACHE.has(typeKey)) {
    const canvas = paintBotSkin(typeKey);
    BOT_SKIN_CACHE.set(typeKey, { texture: canvasToTexture(canvas), imageData: readCanvasImageData(canvas) });
  }
  return BOT_SKIN_CACHE.get(typeKey);
}

/**
 * Swaps a bot type's procedural skin for a real 64x64 skin file, and resolves
 * once it is in the cache. Called before the first match so `getBotSkin` hands
 * the loaded texture back without any change at the spawn site.
 *
 * The image goes through the same canvas -> texture path the procedural skins
 * use, so `flipY`, the nearest-neighbour filtering and the colour space stay
 * identical and the UV rewrite never has to know where the pixels came from.
 *
 * The whole 64x64 sheet is copied rather than just a head region: on a standard
 * skin the hat and jacket overlays are part of the same texture, and dropping
 * them would leave the character wearing an empty second layer.
 */
export function loadBotSkin(typeKey, url) {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const canvas = document.createElement('canvas');
      canvas.width = SKIN_WIDTH;
      canvas.height = SKIN_HEIGHT;
      const ctx = canvas.getContext('2d');
      ctx.imageSmoothingEnabled = false;
      ctx.clearRect(0, 0, SKIN_WIDTH, SKIN_HEIGHT);
      ctx.drawImage(image, 0, 0, SKIN_WIDTH, SKIN_HEIGHT, 0, 0, SKIN_WIDTH, SKIN_HEIGHT);
      const skin = { texture: canvasToTexture(canvas), imageData: readCanvasImageData(canvas) };
      BOT_SKIN_CACHE.set(typeKey, skin);
      resolve(skin);
    };
    image.onerror = () => reject(new Error(`Bot skin failed to load: ${url}`));
    image.src = url;
  });
}

/* ------------------------------------------------------------------ *
 * Character assembly
 * ------------------------------------------------------------------ */

function makeBoxGeometry(sizePx, rects) {
  const geometry = new THREE.BoxGeometry(
    sizePx[0] * SKIN_PX,
    sizePx[1] * SKIN_PX,
    sizePx[2] * SKIN_PX,
  );
  return rewriteBoxUVs(geometry, rects);
}

/**
 * Pick the face rects for a part layer. Standard skins paint the left
 * limbs too; older skins that only painted the right side are handled by
 * reusing the right-arm/right-leg rects for the matching left parts.
 */
function resolveRects(key, imageData, layer) {
  const make = (partKey) => faceRects(layer === 'overlay' ? overlayRegion(partKey) : SKIN_REGIONS[partKey]);
  if (imageData && (key === 'leftArm' || key === 'leftLeg')) {
    const region = layer === 'overlay' ? overlayRegion(key) : SKIN_REGIONS[key];
    const bounds = regionBounds(region);
    if (!hasOpaqueContent(imageData, bounds)) {
      return make(key === 'leftArm' ? 'rightArm' : 'rightLeg');
    }
  }
  return make(key);
}

/**
 * Builds the blocky character group.
 *
 * @param {THREE.Texture}  texture    The 64×64 skin texture.
 * @param {ImageData|null} imageData  Pixel data (same skin) for overlay
 *                                    detection and mirror fallback.
 * @param {object|null}     heldWeapon A gun from HeldWeapons, swapped in for
 *                                    the premade box rifle when supplied. The
 *                                    group, and the hit meshes, are the same
 *                                    either way - only what the character is
 *                                    holding changes.
 */
export function buildMinecraftCharacter({ texture, imageData = null, heldWeapon = null }) {
  const skinMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.85,
    metalness: 0,
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });
  const overlayMaterial = new THREE.MeshStandardMaterial({
    map: texture,
    roughness: 0.85,
    metalness: 0,
    side: THREE.DoubleSide,
    transparent: false,
    alphaTest: 0.1,
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });
  const gunMaterial = new THREE.MeshStandardMaterial({
    color: 0x191f24,
    roughness: 0.62,
    metalness: 0.25,
    flatShading: true,
    emissive: 0xffffff,
    emissiveIntensity: 0,
  });

  const group = new THREE.Group();
  group.name = 'MinecraftCharacter';

  const hitMeshes = [];
  const partMeshes = {};
  let overlayUsed = false;
  let headOverlay = null;

  for (const key of Object.keys(PART_DEFS)) {
    const def = PART_DEFS[key];
    const mesh = new THREE.Mesh(makeBoxGeometry(def.size, resolveRects(key, imageData, 'base')), skinMaterial);
    let pivot = null;
    if (def.pivot) {
      pivot = new THREE.Group();
      pivot.name = `${key}Pivot`;
      pivot.position.set(...def.pivot);
      mesh.position.set(...def.meshOffset);
      pivot.add(mesh);
      group.add(pivot);
    } else {
      mesh.position.set(...def.center);
      group.add(mesh);
    }
    hitMeshes.push(mesh);
    partMeshes[key] = { mesh, pivot };

    // Optional overlay shell (hat).
    if (imageData) {
      const region = overlayRegion(key);
      const bounds = regionBounds(region);
      if (hasOpaqueContent(imageData, bounds)) {
        const overlaySize = def.size.map((px) => px + def.overlayGrow);
        const overlayMesh = new THREE.Mesh(
          makeBoxGeometry(overlaySize, resolveRects(key, imageData, 'overlay')),
          overlayMaterial,
        );
        overlayMesh.position.copy(mesh.position);
        (pivot ?? group).add(overlayMesh);
        if (key === 'head') {
          headOverlay = overlayMesh;
          overlayMesh.userData.head = true;
        }
        hitMeshes.push(overlayMesh);
        overlayUsed = true;
      }
    }
  }

  // The gun is always a group, so the recoil kick and the weapon-swap logic
  // have one thing to move whether it is the premade rifle or a real model.
  const gun = new THREE.Group();
  gun.name = 'BotGun';
  // Recoil drives `position.z`; this is its home, and it is also where the
  // premade rifle hangs, so swapping the contents does not move the hands.
  const GUN_HOME = -0.42;
  let gunMaterialForFlash = gunMaterial;
  let ownedGunMaterials = [gunMaterial];
  let gunMeshes;
  // Where `gun.position.z` rests, so recoil can push off it. The premade rifle
  // hangs its group at -0.42 with the boxes inside; a held model puts the grip
  // anchor in a child group and leaves this one at zero, so both are pushed back
  // by the same amount from their own home.
  let gunHomeZ = GUN_HOME;

  if (heldWeapon) {
    // A real weapon model, already fitted and anchored to the fist. It brings
    // its own group, positioned on the grip, so the anchor travels with the gun
    // and recoil only ever moves this group.
    gun.add(heldWeapon.group);
    gunMaterialForFlash = heldWeapon.flashMaterial ?? gunMaterial;
    ownedGunMaterials = heldWeapon.materials ?? [];
    gunHomeZ = 0;
    gunMeshes = [];
    heldWeapon.group.traverse((child) => {
      if (child.isMesh) gunMeshes.push(child);
    });
  } else {
    gun.position.set(0.30, 1.02, GUN_HOME);
    const stock = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.16, 0.16), gunMaterial);
    stock.position.z = 0.26;
    const receiver = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.2, 0.44), gunMaterial);
    const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.5), gunMaterial);
    barrel.position.z = -0.4;
    gun.add(stock, receiver, barrel);
    gunMeshes = [stock, receiver, barrel];
  }
  group.add(gun);
  hitMeshes.push(...gunMeshes);

  const materials = overlayUsed
    ? [skinMaterial, overlayMaterial, ...ownedGunMaterials]
    : [skinMaterial, ...ownedGunMaterials];

  return {
    group,
    head: partMeshes.head.mesh,
    headOverlay,
    torso: partMeshes.body.mesh,
    leftArm: partMeshes.leftArm.pivot,
    rightArm: partMeshes.rightArm.pivot,
    leftLeg: partMeshes.leftLeg.pivot,
    rightLeg: partMeshes.rightLeg.pivot,
    gun,
    gunHomeZ,
    skinMaterial,
    overlayMaterial: overlayUsed ? overlayMaterial : null,
    gunMaterial: gunMaterialForFlash,
    materials,
    hitMeshes,
  };
}