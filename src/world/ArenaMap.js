import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { GAME_CONFIG } from '../config.js';
import { CollisionWorld } from './CollisionWorld.js';

const ARENA_SIZE = GAME_CONFIG.arenaHalfSize * 2;
const DEFAULT_STEP_TOLERANCE = 0.5;

export class ArenaMap {
  constructor(scene) {
    this.scene = scene;
    this.root = new THREE.Group();
    this.root.name = 'LowPolyArena';
    this.scene.add(this.root);

    this.colliders = [];
    this.raycastTargets = [];
    this.coverColliders = [];
    this.dynamicActors = [];
    // Triangle accurate collision for everything the GLB brings in. This is the
    // single source of truth for body movement, bullet stops and line of sight.
    this.collision = new CollisionWorld();
    this.floorY = 0;
    this.stepTolerance = DEFAULT_STEP_TOLERANCE;
    this.playerSpawns = [
      new THREE.Vector3(0, 0.08, 28),
      new THREE.Vector3(3, 0.08, 28),
    ];
    this.botSpawns = [
      new THREE.Vector3(0, 0.08, -29), new THREE.Vector3(-29, 0.08, -4),
      new THREE.Vector3(29, 0.08, -3), new THREE.Vector3(-29, 0.08, 20),
      new THREE.Vector3(29, 0.08, 20), new THREE.Vector3(-12, 0.08, -27),
      new THREE.Vector3(12, 0.08, -27), new THREE.Vector3(-30, 0.08, 8),
      new THREE.Vector3(30, 0.08, 8), new THREE.Vector3(0, 0.08, -10),
    ];
    this.patrolPoints = [
      new THREE.Vector3(-7, 0.08, 22), new THREE.Vector3(8, 0.08, 23),
      new THREE.Vector3(-17, 0.08, 8), new THREE.Vector3(17, 0.08, 8),
      new THREE.Vector3(-17, 0.08, -7), new THREE.Vector3(13, 0.08, -7),
      new THREE.Vector3(-7, 0.08, -24), new THREE.Vector3(7, 0.08, -24),
      new THREE.Vector3(-29, 0.08, 0), new THREE.Vector3(29, 0.08, 0),
    ];
    this.clouds = [];
    this.climbRoutes = [];
    this.navigation = null;

    // Only used against dynamic actors (bots, projectiles). Static geometry goes
    // through the baked collision world instead, which is solid from both sides.
    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0;
    this.raycaster.far = 200;
    this.tempDirection = new THREE.Vector3();

    this.createLighting();
    this.createSkyDetails();

    this.backupFloor = this.createBackupFloor();
    this.raycastTargets.push(this.backupFloor);
  }

  createBackupFloor() {
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(300, 2, 300),
      new THREE.MeshBasicMaterial({ visible: false }),
    );
    floor.position.y = -1.1; // Slightly below the map's own ground level
    floor.name = 'BackupFloor';
    this.root.add(floor);
    return floor;
  }

  loadMapModel(mapName = 'arena') {
    return new Promise((resolve, reject) => {
      console.log(`[ArenaMap] Loading new 3D map model: ${mapName}...`);

      if (mapName === 'smallarena') {
        this.playerSpawns = [
          new THREE.Vector3(0, 0.08, 4),
          new THREE.Vector3(0, 0.08, -4),
        ];
        this.botSpawns = [
          new THREE.Vector3(4, 0.08, 4), new THREE.Vector3(-4, 0.08, 4),
          new THREE.Vector3(4, 0.08, -4), new THREE.Vector3(-4, 0.08, -4),
          new THREE.Vector3(0, 0.08, 0),
        ];
      } else {
        this.playerSpawns = [
          new THREE.Vector3(0, 0.08, 28),
          new THREE.Vector3(3, 0.08, 28),
        ];
        this.botSpawns = [
          new THREE.Vector3(0, 0.08, -29), new THREE.Vector3(-29, 0.08, -4),
          new THREE.Vector3(29, 0.08, -3), new THREE.Vector3(-29, 0.08, 20),
          new THREE.Vector3(29, 0.08, 20), new THREE.Vector3(-12, 0.08, -27),
          new THREE.Vector3(12, 0.08, -27), new THREE.Vector3(-30, 0.08, 8),
          new THREE.Vector3(30, 0.08, 8), new THREE.Vector3(0, 0.08, -10),
        ];
      }

      const loader = new GLTFLoader();
      loader.load(`/models/${mapName}.glb`, (gltf) => {
        if (this.currentMapModel) this.root.remove(this.currentMapModel);

        this.colliders = [];
        this.raycastTargets = [];
        this.coverColliders = [];
        this.climbRoutes = [];
        this.backupFloor = this.root.getObjectByName('BackupFloor') ?? this.createBackupFloor();
        this.raycastTargets.push(this.backupFloor);

        const model = gltf.scene;
        this.currentMapModel = model;

        if (mapName === 'smallarena') {
          model.scale.set(0.65, 0.65, 0.65); // Sweet spot for map scale
        } else {
          model.scale.set(1, 1, 1);
        }

        this.root.add(model);
        this.root.updateMatrixWorld(true);
        this.createLighting(mapName);

        const modelMeshes = [];
        const foundSpawns = [];

        model.traverse((child) => {
          const n = child.name.toLowerCase();
          // Check for spawn points embedded in the map
          if (n.includes('spawn') || n === '1.1' || n === '2.2') {
            const pos = new THREE.Vector3();
            child.getWorldPosition(pos);
            foundSpawns.push(pos);
            child.visible = false; // Hide the spawn point marker
          }

          if (!child.isMesh) return;
          child.castShadow = true;
          child.receiveShadow = true;

          if (n.includes('cube.006_0') || n.includes('cube.035_0') || n.includes('cube.007_0') ||
            n.includes('dube.0035') || n.includes('sube.007') || n.includes('cube006') || n.includes('cube035') || n.includes('cube007')) {
            child.scale.multiplyScalar(0.80); // A bit larger
            child.updateMatrixWorld(true);
          }

          if (child.material) {
            const mats = Array.isArray(child.material) ? child.material : [child.material];
            mats.forEach(mat => {
              if (mat.metalness !== undefined) mat.metalness = 0.1;
              if (mat.roughness !== undefined) mat.roughness = 0.8;
              if (mapName === 'smalltdm' && child.geometry && child.geometry.attributes.color) {
                mat.vertexColors = true;
              }

              // Force FrontSide to fix severe shadow acne from GLB doubleSided exports
              mat.side = THREE.FrontSide;
              mat.shadowSide = THREE.BackSide;
              mat.needsUpdate = true;
            });
          }

          modelMeshes.push(child);


          // AABBs are still useful for cover scoring; movement collision comes
          // from the triangle accurate world below, so coarse boxes are harmless.
          const box = new THREE.Box3().setFromObject(child);
          const size = box.getSize(new THREE.Vector3());
          const center = box.getCenter(new THREE.Vector3());
          const isSmallObject = size.x <= 8 && size.z <= 8 && size.y >= 0.25;
          const collider = {
            center,
            size,
            min: box.min.clone(),
            max: box.max.clone(),
            cover: isSmallObject,
            isTerrain: !isSmallObject,
          };
          this.colliders.push(collider);
          if (isSmallObject) this.coverColliders.push(collider);
        });

        // Use custom spawns if the map provided them
        if (foundSpawns.length > 0) {
          this.playerSpawns = foundSpawns;
          this.botSpawns = foundSpawns;
          this.hasMapSpawns = true;
        } else {
          this.hasMapSpawns = false;
        }

        // Adjust shadow bias for the map to reduce any remaining acne
        if (this.sun) {
          if (mapName === 'smallarena') {
            this.sun.shadow.normalBias = 0.2; // High normal bias for thin planes
            this.sun.shadow.bias = -0.002;
          } else {
            this.sun.shadow.normalBias = 0.025;
            this.sun.shadow.bias = -0.0004;
          }
        }

        this.modelMeshes = modelMeshes;
        this.buildCollision(modelMeshes, [this.backupFloor]);
        console.log(
          `[ArenaMap] 3D map loaded: ${this.collision.triangleCount} collision triangles, `
          + `${this.collision.chunks.length} chunks, floor at y=${this.floorY.toFixed(2)}`,
        );
        resolve();
      }, undefined, (error) => {
        console.error('[ArenaMap] Error loading map GLB:', error);
        reject(error);
      });
    });
  }

  /**
   * Bakes the given meshes into the static collision world. Every static surface
   * in the arena must be listed here: this is what bodies stand on, collide with
   * and what bullets stop against.
   */
  buildCollision(meshes, extraMeshes = []) {
    this.root.updateMatrixWorld(true);
    const rootInverse = new THREE.Matrix4().copy(this.root.matrixWorld).invert();
    this.collision.begin(rootInverse);
    for (const mesh of meshes) this.collision.addMesh(mesh);
    for (const mesh of extraMeshes) this.collision.addMesh(mesh);
    this.collision.finalize();
    this.floorY = this.collision.floorY;
    return this.collision;
  }

  createLighting(mapName = 'arena') {
    if (this.lightGroup) {
      this.scene.remove(this.lightGroup);
    }
    this.lightGroup = new THREE.Group();
    this.scene.add(this.lightGroup);

    if (mapName === 'smalltdm') {
      // Dim, ambient light to simulate ambient warehouse bouncing
      const ambient = new THREE.AmbientLight(0xffeedd, 0.15);
      this.lightGroup.add(ambient);

      // Hemisphere: dim industrial ceiling bounce, dark floor bounce
      const hemisphere = new THREE.HemisphereLight(0x555566, 0x1a1614, 0.4);
      this.lightGroup.add(hemisphere);

      // Big yellow light in the middle of the roof, softened based on feedback
      const sun = new THREE.SpotLight(0xffe299, 15000);
      sun.position.set(0, 45, 0);
      sun.angle = Math.PI / 2.5;
      sun.penumbra = 0.5;
      sun.distance = 250;
      sun.decay = 2;
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.near = 10;
      sun.shadow.camera.far = 100;
      sun.shadow.camera.fov = 85;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.025;

      this.lightGroup.add(sun);

      const target = new THREE.Object3D();
      target.position.set(0, 0, 0);
      this.lightGroup.add(target);
      sun.target = target;
      this.sun = sun;

      // Fill light: very subtle, just to ensure shadows aren't pitch black
      const fill = new THREE.DirectionalLight(0x445566, 0.3);
      fill.position.set(20, 10, 20);
      this.lightGroup.add(fill);
    } else {
      // Default daylight for large arena
      const ambient = new THREE.AmbientLight(0xffffff, 0.55);
      this.lightGroup.add(ambient);

      const hemisphere = new THREE.HemisphereLight(0xdcebff, 0x8f8578, 0.9);
      this.lightGroup.add(hemisphere);

      const sun = new THREE.DirectionalLight(0xfff6ea, 2.6);
      sun.position.set(-20, 45, 20);
      sun.castShadow = true;
      sun.shadow.mapSize.set(2048, 2048);
      sun.shadow.camera.left = -42;
      sun.shadow.camera.right = 42;
      sun.shadow.camera.top = 42;
      sun.shadow.camera.bottom = -42;
      sun.shadow.camera.near = 1;
      sun.shadow.camera.far = 350;
      sun.shadow.bias = -0.0004;
      sun.shadow.normalBias = 0.025;
      this.lightGroup.add(sun);
      this.sun = sun;

      const fill = new THREE.DirectionalLight(0xdce8ff, 0.6);
      fill.position.set(30, 30, -25);
      this.lightGroup.add(fill);
    }
  }

  createGround() {
    const groundMaterial = new THREE.MeshStandardMaterial({ color: 0x080808, roughness: 1 });
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(ARENA_SIZE, ARENA_SIZE), groundMaterial);
    ground.rotation.x = -Math.PI / 2;
    ground.position.y = -0.02;
    ground.receiveShadow = true;
    ground.name = 'ArenaGround';
    this.root.add(ground);
    this.raycastTargets.push(ground);

    const outer = new THREE.Mesh(
      new THREE.PlaneGeometry(180, 180),
      new THREE.MeshStandardMaterial({ color: 0x6d886d, roughness: 1 }),
    );
    outer.rotation.x = -Math.PI / 2;
    outer.position.y = -0.08;
    outer.receiveShadow = true;
    this.scene.add(outer);

    const plaza = new THREE.Mesh(
      new THREE.CylinderGeometry(11.4, 11.4, 0.09, 12),
      new THREE.MeshStandardMaterial({ color: 0xa9aa92, roughness: 0.95 }),
    );
    plaza.position.y = 0.035;
    plaza.receiveShadow = true;
    this.root.add(plaza);
    this.raycastTargets.push(plaza);
  }

  createRoads() {
    const asphalt = new THREE.MeshStandardMaterial({ color: 0x45545a, roughness: 0.92 });
    const curb = new THREE.MeshStandardMaterial({ color: 0xc2bd9f, roughness: 0.9 });
    this.box({ size: [10.5, 0.06, 65], position: [0, 0.045, 0], material: asphalt, castRay: true, receiveShadow: true });
    this.box({ size: [65, 0.06, 10.5], position: [0, 0.046, 0], material: asphalt, castRay: true, receiveShadow: true });

    for (let z = -30; z <= 30; z += 5) {
      this.box({ size: [0.16, 0.025, 2.1], position: [0, 0.09, z], material: curb });
    }
    for (let x = -30; x <= 30; x += 5) {
      this.box({ size: [2.1, 0.025, 0.16], position: [x, 0.091, 0], material: curb });
    }

    for (const z of [-25.2, 25.2]) {
      this.box({ size: [10.8, 0.16, 0.35], position: [0, 0.12, z], material: curb });
    }
    for (const x of [-25.2, 25.2]) {
      this.box({ size: [0.35, 0.16, 10.8], position: [x, 0.12, 0], material: curb });
    }
  }

  createBuildings() {
    this.createBuilding({ x: -21, z: -19, width: 11, depth: 9, height: 6.4, color: 0x7d8990, roof: 0x46565f });
    this.createBuilding({ x: 21, z: -19, width: 11, depth: 9, height: 6.4, color: 0xa87f68, roof: 0x684d43 });
    this.createBuilding({ x: -21, z: 19, width: 11, depth: 9, height: 5.9, color: 0x6f8d7e, roof: 0x405b4e });
    this.createBuilding({ x: 21, z: 19, width: 11, depth: 9, height: 5.9, color: 0x8d7d99, roof: 0x554963 });

    this.createBuilding({ x: -12, z: 10, width: 6.5, depth: 6, height: 4.25, color: 0xb19568, roof: 0x6d5b3d, small: true });
    this.createBuilding({ x: 12, z: 10, width: 6.5, depth: 6, height: 4.25, color: 0x668b9b, roof: 0x3b5967, small: true });
  }

  createBuilding({ x, z, width, depth, height, color, roof, small = false }) {
    const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.88, flatShading: true });
    const trimMaterial = new THREE.MeshStandardMaterial({ color: roof, roughness: 0.9, flatShading: true });
    const glassMaterial = new THREE.MeshStandardMaterial({
      color: 0x9ee2ef, emissive: 0x173d4c, emissiveIntensity: 0.45,
      roughness: 0.35, metalness: 0.1,
    });
    const body = this.box({
      size: [width, height, depth], position: [x, height / 2, z], material: bodyMaterial,
      collider: true, cover: true, castRay: true, castShadow: true, receiveShadow: true,
    });
    body.name = 'LowPolyBuilding';

    const roofY = height + 0.13;
    this.box({ size: [width + 0.45, 0.26, depth + 0.45], position: [x, roofY, z], material: trimMaterial, collider: true, castRay: true });
    this.box({ size: [width + 0.25, 0.48, 0.3], position: [x, height + 0.48, z - depth / 2 - 0.05], material: trimMaterial, collider: true });
    this.box({ size: [0.3, 0.48, depth], position: [x - width / 2 - 0.05, height + 0.48, z], material: trimMaterial, collider: true });
    this.box({ size: [0.3, 0.48, depth], position: [x + width / 2 + 0.05, height + 0.48, z], material: trimMaterial, collider: true });

    const windowRows = small ? 1 : 2;
    const columns = Math.max(2, Math.floor(width / 2.4));
    for (let row = 0; row < windowRows; row += 1) {
      const y = 1.65 + row * 2.25;
      for (let column = 0; column < columns; column += 1) {
        const wx = x - width * 0.36 + column * (width * 0.72 / Math.max(1, columns - 1));
        this.box({ size: [1.05, 0.82, 0.07], position: [wx, y, z + depth / 2 + 0.045], material: glassMaterial });
      }
    }
    const sideWindows = Math.max(1, Math.floor(depth / 2.8));
    for (let index = 0; index < sideWindows; index += 1) {
      const wz = z - depth * 0.3 + index * (depth * 0.6 / Math.max(1, sideWindows - 1));
      this.box({ size: [0.07, 0.8, 1], position: [x - width / 2 - 0.045, 1.72, wz], material: glassMaterial });
      this.box({ size: [0.07, 0.8, 1], position: [x + width / 2 + 0.045, 1.72, wz], material: glassMaterial });
    }

    const doorColor = new THREE.MeshStandardMaterial({ color: 0x263942, roughness: 0.55, metalness: 0.25 });
    this.box({ size: [1.35, 2.05, 0.1], position: [x, 1.025, z + depth / 2 + 0.07], material: doorColor });

    const stairRoute = this.createStairs(x, z + depth / 2, height, small ? 3 : 3.1);
    this.climbRoutes.push({
      minX: x - width / 2 - 0.2,
      maxX: x + width / 2 + 0.2,
      minZ: z - depth / 2 - 0.2,
      maxZ: z + depth / 2 + 0.2,
      roofY: height + 0.26,
      route: stairRoute,
    });
    if (!small) {
      this.box({ size: [1.4, 0.8, 1.1], position: [x - width * 0.27, height + 0.67, z], material: trimMaterial, collider: true });
    }
  }

  createStairs(frontX, frontZ, height, width) {
    const steps = smallStepCount(height);
    const stepHeight = height / steps;
    const depth = 0.7;
    const material = new THREE.MeshStandardMaterial({ color: 0x8b918d, roughness: 0.95, flatShading: true });
    const route = [new THREE.Vector3(frontX, 0.08, frontZ + depth * steps + 0.8)];
    for (let index = 0; index < steps; index += 1) {
      const top = stepHeight * (index + 1);
      const z = frontZ + depth * (steps - index - 0.5);
      this.box({
        size: [width, top, depth], position: [frontX, top / 2, z], material,
        collider: true, castRay: true, castShadow: true, receiveShadow: true,
      });
      route.push(new THREE.Vector3(frontX, top, z));
    }
    route.push(new THREE.Vector3(frontX, height + 0.26, frontZ + 0.35));
    route.push(new THREE.Vector3(frontX, height + 0.26, frontZ - 0.35));
    return route;
  }

  createCentralStructures() {
    this.createBuilding({ x: 0, z: -5, width: 5, depth: 4, height: 3.2, color: 0x627a82, roof: 0x34474e, small: true });

    const fountainBaseMaterial = new THREE.MeshStandardMaterial({ color: 0x9b9c8c, roughness: 0.94, flatShading: true });
    const fountain = new THREE.Mesh(new THREE.CylinderGeometry(2.15, 2.4, 0.72, 8), fountainBaseMaterial);
    fountain.position.set(0, 0.4, 6);
    fountain.castShadow = true;
    fountain.receiveShadow = true;
    this.root.add(fountain);
    this.raycastTargets.push(fountain);
    this.addBoxCollider(new THREE.Vector3(0, 0.4, 6), new THREE.Vector3(4.2, 0.72, 4.2), true);

    const water = new THREE.Mesh(
      new THREE.CylinderGeometry(1.8, 1.8, 0.08, 12),
      new THREE.MeshStandardMaterial({ color: 0x4fcbd3, emissive: 0x0c6570, emissiveIntensity: 0.38, roughness: 0.2, metalness: 0.15 }),
    );
    water.position.set(0, 0.8, 6);
    this.root.add(water);
    this.raycastTargets.push(water);

    const center = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.55, 0),
      new THREE.MeshStandardMaterial({ color: 0x8ef4f1, emissive: 0x2bb5ba, emissiveIntensity: 0.75, roughness: 0.25 }),
    );
    center.position.set(0, 1.55, 6);
    center.castShadow = true;
    this.root.add(center);
    this.raycastTargets.push(center);
  }

  createCoverProps() {
    const barriers = [
      [-7, 7, 0], [7, 2, Math.PI / 2], [-7, -10, 0], [8, -10, Math.PI / 2],
      [-11, 25, 0], [12, 25, 0], [-25, -9, Math.PI / 2], [25, 9, Math.PI / 2],
      [0, -14, 0], [-3, 16, Math.PI / 2],
    ];
    barriers.forEach(([x, z, rotation], index) => this.createBarrier(x, z, rotation, index % 2));

    const cratePositions = [
      [-15, 5, 0], [-14.1, 5, 0], [15, -7, 1], [16, -6, 0],
      [-4, -20, 0], [5, 19, 0], [-28, 25, 0], [27, -24, 0],
      [-8, 29, 0], [9, -28, 0], [-16, -28, 0], [16, 28, 0],
    ];
    cratePositions.forEach(([x, z, stacked], index) => {
      this.createCrate(x, z, 1.35, 0xb77943, index % 3 === 0);
      if (stacked) this.createCrate(x + 0.08, z - 0.03, 1.05, 0xd49b5b, index % 2);
    });

    const lowWallMaterial = new THREE.MeshStandardMaterial({ color: 0x87918b, roughness: 0.94, flatShading: true });
    this.box({ size: [5, 1.05, 0.55], position: [18, 0.525, 3], material: lowWallMaterial, collider: true, cover: true, castRay: true, castShadow: true });
    this.box({ size: [0.55, 1.05, 5], position: [-19, 0.525, -3], material: lowWallMaterial, collider: true, cover: true, castRay: true, castShadow: true });

    const planterMaterial = new THREE.MeshStandardMaterial({ color: 0x6b7c70, roughness: 0.9, flatShading: true });
    for (const [x, z] of [[-7, -1], [7, -1], [-7, 12], [7, 12]]) {
      this.box({ size: [2.4, 0.7, 1.1], position: [x, 0.35, z], material: planterMaterial, collider: true, cover: true, castRay: true });
      const bush = new THREE.Mesh(
        new THREE.IcosahedronGeometry(0.7, 0),
        new THREE.MeshStandardMaterial({ color: 0x4c8b63, roughness: 1, flatShading: true }),
      );
      bush.position.set(x, 1.05, z);
      bush.scale.set(1.2, 0.75, 0.7);
      bush.castShadow = true;
      this.root.add(bush);
    }
  }

  createBarrier(x, z, rotation, variant) {
    const material = new THREE.MeshStandardMaterial({
      color: variant ? 0xd0a253 : 0xb5b7aa, roughness: 0.9, flatShading: true,
    });
    const dark = new THREE.MeshStandardMaterial({ color: 0x535e5e, roughness: 0.8 });
    const horizontal = Math.abs(Math.sin(rotation)) < 0.5;
    const size = horizontal ? [3.3, 0.95, 0.55] : [0.55, 0.95, 3.3];
    const collider = this.box({
      size, position: [x, 0.52, z], material, collider: true, cover: true,
      castRay: true, castShadow: true, receiveShadow: true,
    });
    this.addBoxCollider(new THREE.Vector3(x, 0.16, z), horizontal ? new THREE.Vector3(2.5, 0.32, 1.1) : new THREE.Vector3(1.1, 0.32, 2.5), false);
    this.box({
      size: horizontal ? [3.5, 0.16, 0.72] : [0.72, 0.16, 3.5],
      position: [x, 0.08, z], material: dark,
    });
    const stripe = new THREE.MeshStandardMaterial({ color: 0xf0d06a, roughness: 0.75 });
    for (const offset of [-0.9, 0, 0.9]) {
      this.box({
        size: horizontal ? [0.38, 0.58, 0.04] : [0.04, 0.58, 0.38],
        position: [x + (horizontal ? offset : 0), 0.63, z + (horizontal ? 0.3 : offset)],
        material: stripe,
      });
    }
    collider.name = 'ConcreteBarrier';
  }

  createCrate(x, z, size, color, variant) {
    const material = new THREE.MeshStandardMaterial({ color, roughness: 0.92, flatShading: true });
    const bandMaterial = new THREE.MeshStandardMaterial({ color: variant ? 0x5a4331 : 0x704d33, roughness: 0.9 });
    this.box({
      size: [size, size, size], position: [x, size / 2, z], material,
      collider: true, cover: true, castRay: true, castShadow: true, receiveShadow: true,
    });
    this.box({ size: [size + 0.025, size * 0.12, size + 0.035], position: [x, size * 0.5, z], material: bandMaterial });
    this.box({ size: [size * 0.12, size + 0.03, size + 0.035], position: [x, size / 2, z], material: bandMaterial });
  }

  createVegetation() {
    const treePositions = [
      [-30, -28], [-30, 27], [30, -28], [30, 27], [-25, 28], [25, 28],
      [-28, -20], [28, -20], [-15, -24], [15, -24], [-28, 3], [28, 3],
    ];
    for (let index = 0; index < treePositions.length; index += 1) {
      const [x, z] = treePositions[index];
      this.createTree(x, z, 0.85 + (index % 3) * 0.12, index % 2 === 0 ? 0x2f7856 : 0x427c53);
    }
  }

  createTree(x, z, scale, color) {
    const trunk = new THREE.Mesh(
      new THREE.CylinderGeometry(0.2, 0.28, 2.5, 6),
      new THREE.MeshStandardMaterial({ color: 0x75533a, roughness: 1, flatShading: true }),
    );
    trunk.position.set(x, 1.25, z);
    trunk.scale.set(scale, scale, scale);
    trunk.castShadow = true;
    trunk.receiveShadow = true;
    this.root.add(trunk);
    this.raycastTargets.push(trunk);
    this.addBoxCollider(new THREE.Vector3(x, 1.25, z), new THREE.Vector3(0.55, 2.5, 0.55), false);

    const foliageMaterial = new THREE.MeshStandardMaterial({ color, roughness: 1, flatShading: true });
    for (let layer = 0; layer < 2; layer += 1) {
      const foliage = new THREE.Mesh(new THREE.IcosahedronGeometry(1.25, 0), foliageMaterial);
      foliage.position.set(x + (layer ? 0.12 : -0.08), (2.6 + layer * 1.05) * scale, z);
      foliage.scale.set(scale * (1.08 - layer * 0.18), scale * (1.2 - layer * 0.13), scale);
      foliage.rotation.y = indexSeed(x + z + layer) * Math.PI;
      foliage.castShadow = true;
      this.root.add(foliage);
    }
  }

  createStreetDetails() {
    const lampPositions = [
      [-6.2, 19], [6.2, 19], [-6.2, 9], [6.2, -9], [-6.2, -18], [6.2, -27],
      [-18, 6.2], [-11, -6.2], [18, 6.2], [11, -6.2], [25, -18], [-25, 18],
    ];
    lampPositions.forEach(([x, z], index) => this.createStreetLamp(x, z, index % 3 === 0));

    this.createBench(-12, 26.7, 0);
    this.createBench(13, 25.7, Math.PI);
    this.createBench(-25, 10, Math.PI / 2);
    this.createSign(-4.2, 18, 0, 'SECTOR 07');
    this.createSign(4.2, -14, Math.PI, 'CHECKPOINT');
    this.createSign(0, -28, 0, 'NORTH EXIT');
  }

  createStreetLamp(x, z, withLight) {
    const poleMaterial = new THREE.MeshStandardMaterial({ color: 0x35434a, roughness: 0.65, metalness: 0.35 });
    const pole = new THREE.Mesh(new THREE.CylinderGeometry(0.08, 0.11, 4.6, 6), poleMaterial);
    pole.position.set(x, 2.3, z);
    pole.castShadow = true;
    this.root.add(pole);
    this.raycastTargets.push(pole);
    this.addBoxCollider(new THREE.Vector3(x, 2.3, z), new THREE.Vector3(0.28, 4.6, 0.28), false);

    const arm = this.box({ size: [1.15, 0.11, 0.11], position: [x - Math.sign(x) * 0.48, 4.55, z], material: poleMaterial, castRay: true });
    arm.castShadow = true;
    const lampMaterial = new THREE.MeshStandardMaterial({
      color: 0xffe7a2, emissive: 0xffbd55, emissiveIntensity: 1.25, roughness: 0.35,
    });
    const lamp = new THREE.Mesh(new THREE.OctahedronGeometry(0.3, 0), lampMaterial);
    lamp.position.set(x - Math.sign(x || 1) * 0.92, 4.48, z);
    lamp.scale.y = 0.65;
    this.root.add(lamp);
    this.raycastTargets.push(lamp);
    if (withLight) {
      const light = new THREE.PointLight(0xffc76d, 7, 8, 2);
      light.position.copy(lamp.position).add(new THREE.Vector3(0, -0.15, 0));
      this.root.add(light);
    }
  }

  createBench(x, z, rotation) {
    const group = new THREE.Group();
    group.position.set(x, 0, z);
    group.rotation.y = rotation;
    const wood = new THREE.MeshStandardMaterial({ color: 0x956342, roughness: 0.92, flatShading: true });
    const metal = new THREE.MeshStandardMaterial({ color: 0x3e4b50, roughness: 0.65, metalness: 0.25 });
    for (let i = 0; i < 3; i += 1) {
      const seat = new THREE.Mesh(new THREE.BoxGeometry(2.5, 0.13, 0.22), wood);
      seat.position.set(0, 0.62, -0.3 + i * 0.3);
      seat.castShadow = true;
      group.add(seat);
      this.raycastTargets.push(seat);
    }
    for (const xSide of [-0.9, 0.9]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.65, 0.65), metal);
      leg.position.set(xSide, 0.32, 0);
      group.add(leg);
      this.raycastTargets.push(leg);
    }
    this.root.add(group);
    const size = Math.abs(Math.sin(rotation)) < 0.5 ? new THREE.Vector3(2.6, 0.8, 0.8) : new THREE.Vector3(0.8, 0.8, 2.6);
    this.addBoxCollider(new THREE.Vector3(x, 0.4, z), size, false);
  }

  createSign(x, z, rotation, text) {
    const canvas = document.createElement('canvas');
    canvas.width = 512;
    canvas.height = 128;
    const context = canvas.getContext('2d');
    context.fillStyle = '#12242d';
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.strokeStyle = '#72d3d1';
    context.lineWidth = 8;
    context.strokeRect(8, 8, canvas.width - 16, canvas.height - 16);
    context.fillStyle = '#e8f6ed';
    context.font = '700 52px monospace';
    context.textAlign = 'center';
    context.textBaseline = 'middle';
    context.fillText(text, canvas.width / 2, canvas.height / 2 + 3);
    const texture = new THREE.CanvasTexture(canvas);
    texture.colorSpace = THREE.SRGBColorSpace;
    const material = new THREE.MeshStandardMaterial({ map: texture, emissive: 0xffffff, emissiveMap: texture, emissiveIntensity: 0.15, roughness: 0.75 });
    const sign = new THREE.Mesh(new THREE.PlaneGeometry(2.2, 0.55), material);
    sign.position.set(x, 2.1, z);
    sign.rotation.y = rotation;
    sign.castShadow = true;
    this.root.add(sign);
    const postMaterial = new THREE.MeshStandardMaterial({ color: 0x425056, roughness: 0.7, metalness: 0.3 });
    for (const offset of [-0.8, 0.8]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 2, 0.08), postMaterial);
      post.position.set(x + Math.cos(rotation) * offset, 1, z - Math.sin(rotation) * offset);
      this.root.add(post);
    }
  }

  createBoundary() {
    const wallMaterial = new THREE.MeshStandardMaterial({ color: 0x6f7772, roughness: 0.95, flatShading: true });
    const capMaterial = new THREE.MeshStandardMaterial({ color: 0x4a5757, roughness: 0.85 });
    this.box({ size: [68, 3, 1], position: [0, 1.5, -34], material: wallMaterial, collider: true, castRay: true, castShadow: true });
    this.box({ size: [68, 3, 1], position: [0, 1.5, 34], material: wallMaterial, collider: true, castRay: true, castShadow: true });
    this.box({ size: [1, 3, 68], position: [-34, 1.5, 0], material: wallMaterial, collider: true, castRay: true, castShadow: true });
    this.box({ size: [1, 3, 68], position: [34, 1.5, 0], material: wallMaterial, collider: true, castRay: true, castShadow: true });

    this.box({ size: [68.3, 0.22, 1.3], position: [0, 3.08, -34], material: capMaterial });
    this.box({ size: [68.3, 0.22, 1.3], position: [0, 3.08, 34], material: capMaterial });
    this.box({ size: [1.3, 0.22, 68], position: [-34, 3.08, 0], material: capMaterial });
    this.box({ size: [1.3, 0.22, 68], position: [34, 3.08, 0], material: capMaterial });

    const fenceMaterial = new THREE.MeshStandardMaterial({ color: 0x566b6b, roughness: 0.65, metalness: 0.35 });
    for (const z of [-33.3, 33.3]) {
      for (let x = -32; x <= 32; x += 2.5) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.08, 1.25, 0.08), fenceMaterial);
        post.position.set(x, 0.72, z);
        this.root.add(post);
      }
      for (const y of [0.55, 1.15]) {
        const rail = new THREE.Mesh(new THREE.BoxGeometry(66, 0.055, 0.055), fenceMaterial);
        rail.position.set(0, y, z);
        this.root.add(rail);
      }
    }
  }

  createSkyDetails() {
    const cloudMaterial = new THREE.MeshStandardMaterial({ color: 0xf1f4e8, roughness: 1, flatShading: true, transparent: true, opacity: 0.88 });
    for (let index = 0; index < 10; index += 1) {
      const cloud = new THREE.Group();
      cloud.position.set(-65 + index * 14, 25 + (index % 3) * 3, -45 - (index % 2) * 22);
      for (let piece = 0; piece < 3; piece += 1) {
        const mesh = new THREE.Mesh(new THREE.IcosahedronGeometry(1.9 + piece * 0.3, 0), cloudMaterial);
        mesh.position.set(piece * 1.5, piece % 2 ? 0.45 : 0, (piece - 1) * 0.55);
        mesh.scale.set(1.7, 0.65 + (piece % 2) * 0.2, 1);
        cloud.add(mesh);
      }
      this.scene.add(cloud);
      this.clouds.push(cloud);
    }
  }

  box({ size, position, material, collider = false, cover = false, castRay = false, castShadow = false, receiveShadow = true }) {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(...size), material);
    mesh.position.set(...position);
    mesh.castShadow = castShadow;
    mesh.receiveShadow = receiveShadow;
    this.root.add(mesh);
    if (castRay) this.raycastTargets.push(mesh);
    if (collider) {
      this.addBoxCollider(new THREE.Vector3(...position), new THREE.Vector3(...size), cover);
      if (!castRay) this.raycastTargets.push(mesh);
    }
    return mesh;
  }

  addBoxCollider(center, size, cover) {
    const collider = {
      center: center.clone(),
      size: size.clone(),
      min: center.clone().sub(size.clone().multiplyScalar(0.5)),
      max: center.clone().add(size.clone().multiplyScalar(0.5)),
      cover,
    };
    this.colliders.push(collider);
    if (cover) this.coverColliders.push(collider);
    return collider;
  }

  setNavigation(navigation) {
    this.navigation = navigation;
  }

  setDynamicActors(actors) {
    this.dynamicActors = actors;
  }

  /** Snaps a world XZ onto the real surface and confirms a body fits there. */
  groundSnap(point, radius = 0.4, bodyHeight = 1.8) {
    const ground = this.collision.groundHeight(point.x, point.z, radius, point.y + 40, 90);
    const feet = Number.isFinite(ground) ? ground : this.floorY;
    const candidate = new THREE.Vector3(point.x, feet + 0.04, point.z);
    if (this.canPlayerOccupy(candidate, radius, bodyHeight, null, 0.02)) return candidate;
    return null;
  }

  getPlayerSpawn() {
    if (this.hasMapSpawns) {
      // Pick a random custom spawn point
      const spawn = this.playerSpawns[Math.floor(Math.random() * this.playerSpawns.length)].clone();
      // Raise by 1.5m to ensure they drop safely onto the floor instead of clipping through it
      return spawn.setY(spawn.y + 1.5);
    }

    const fallback = this.playerSpawns[Math.floor(Math.random() * this.playerSpawns.length)].clone();
    let best = null;

    if (this.navigation) {
      for (let attempts = 0; attempts < 140; attempts += 1) {
        const cx = Math.floor(Math.random() * this.navigation.size);
        const cz = Math.floor(Math.random() * this.navigation.size);
        if (!this.navigation.isWalkableCell(cx, cz)) continue;
        const snapped = this.groundSnap(this.navigation.cellToWorld(cx, cz), 0.42, 1.8);
        if (snapped) return snapped;
      }
    }

    best = this.groundSnap(fallback, 0.42, 1.8);
    if (best) return best;

    // Last resort: anywhere with clear sky above the base floor.
    for (let attempt = 0; attempt < 60; attempt += 1) {
      const angle = Math.random() * Math.PI * 2;
      const radius = 4 + Math.random() * 24;
      const probe = new THREE.Vector3(
        Math.cos(angle) * radius,
        this.floorY,
        Math.sin(angle) * radius,
      );
      const snapped = this.groundSnap(probe, 0.42, 1.8);
      if (snapped) return snapped;
    }
    return fallback.setY(this.floorY + 0.04);
  }

  findClimbRoute(from, target) {
    if (!target || target.y < 1.2) return null;
    for (const climb of this.climbRoutes) {
      if (target.x < climb.minX || target.x > climb.maxX || target.z < climb.minZ || target.z > climb.maxZ) continue;
      if (target.y < climb.roofY - 0.6 || from.y >= climb.roofY - 0.05) continue;
      return climb.route;
    }
    return null;
  }

  /**
   * Check if a player-sized cylinder can occupy the given position.
   * Uses AABB checks for hand-placed objects + mesh raycasting for GLB model geometry.
   */
  canPlayerOccupy(position, radius, height, ignoreActor = null, stepTolerance = 0) {
    const bottom = position.y;
    const top = position.y + height;

    // Static map geometry. Winding agnostic and solid from either side, so a
    // body can never end up walking through a building. The baked world is a
    // superset of every mesh, which is why the coarse AABB list is deliberately
    // not consulted here: those boxes enclose free space and used to block
    // perfectly valid spots (the source of bodies hanging in the air).
    if (this.collision.overlapsCylinder(position.x, position.z, bottom, top, radius, stepTolerance)) {
      return false;
    }

    // Other bodies.
    for (const actor of this.dynamicActors) {
      if (actor.owner === ignoreActor || actor.owner.dead || actor.owner.removed) continue;
      const actorBottom = actor.position.y;
      const actorTop = actor.position.y + actor.height;
      if (top <= actorBottom + 0.001 || bottom >= actorTop - 0.001) continue;
      const dx = position.x - actor.position.x;
      const dz = position.z - actor.position.z;
      const separation = radius + actor.radius;
      if (dx * dx + dz * dz < separation * separation) return false;
    }
    return true;
  }

  moveCircle(position, deltaX, deltaZ, radius, height, ignoreActor = null, stepTolerance = this.stepTolerance) {
    const y = position.y;
    const tentativeX = position.clone();
    tentativeX.x += deltaX;
    if (this.canPlayerOccupy(tentativeX, radius, height, ignoreActor, stepTolerance)) position.x = tentativeX.x;
    const tentativeZ = position.clone();
    tentativeZ.z += deltaZ;
    if (this.canPlayerOccupy(tentativeZ, radius, height, ignoreActor, stepTolerance)) position.z = tentativeZ.z;
    position.y = y;
  }

  /** Steps up onto anything short enough, then retries the slide. */
  tryStepMove(position, deltaX, deltaZ, radius, height, stepHeight, ignoreActor = null) {
    const tentative = position.clone();
    tentative.x += deltaX;
    tentative.z += deltaZ;
    if (this.canPlayerOccupy(tentative, radius, height, ignoreActor, stepHeight)) {
      position.copy(tentative);
      return true;
    }
    const ground = this.getGroundHeight(tentative, radius, position.y, position.y, stepHeight + 0.45);
    const rise = ground - position.y;
    if (!Number.isFinite(ground) || rise <= 0.02 || rise > stepHeight) return false;
    const stepped = tentative.clone();
    stepped.y = ground;
    if (!this.canPlayerOccupy(stepped, radius, height, ignoreActor, 0.02)) return false;
    position.copy(stepped);
    return true;
  }

  getCeilingHeight(position, radius, currentHeight, proposedHeight, bodyHeight) {
    return this.collision.ceilingHeight(
      position.x,
      position.z,
      Math.min(radius, 0.36),
      currentHeight,
      bodyHeight + 1.2,
    );
  }

  /**
   * Highest solid surface at or below the proposed height, searched across the
   * body's footprint so it never falls through the seams between triangles.
   * Never returns -Infinity, so a body can never get stuck floating in the air.
   */
  getGroundHeight(position, radius, currentHeight, proposedHeight = currentHeight, maxDrop = 3.4) {
    const from = Math.max(currentHeight, proposedHeight);
    const ground = this.collision.groundHeight(position.x, position.z, radius, from, maxDrop);
    if (Number.isFinite(ground)) return ground;
    return Math.min(from, this.floorY);
  }

  /**
   * First solid surface along a ray, from the baked map geometry. Double sided,
   * so a shot that starts inside geometry still stops there.
   */
  traceShot(origin, direction, far) {
    return this.collision.raycast(origin, direction, far);
  }

  /** True when the map has geometry between the two points. */
  traceWorldSegment(origin, target) {
    const direction = target.clone().sub(origin);
    const distance = direction.length();
    if (distance < 0.02) return null;
    return this.collision.raycast(origin, direction, distance);
  }

  getDynamicHitMeshes(excludeActor = null) {
    const meshes = [];
    for (const actor of this.dynamicActors) {
      if (actor.owner === excludeActor || !actor.owner.hitMeshes) continue;
      actor.owner.root.updateMatrixWorld(true);
      meshes.push(...actor.owner.hitMeshes);
    }
    return meshes;
  }

  isSegmentClear(origin, target, extraTargets = []) {
    const direction = new THREE.Vector3().subVectors(target, origin);
    const distance = direction.length();
    if (distance < 0.01) return true;
    // A small inset keeps an eye sitting inside cover geometry from blocking itself.
    const inset = Math.max(0.12, distance * 0.01);
    if (this.collision.raycast(origin, direction, distance - inset)) return false;
    if (extraTargets.length) {
      this.raycaster.set(origin, direction.normalize());
      this.raycaster.far = distance - inset;
      return this.raycaster.intersectObjects(extraTargets, false).length === 0;
    }
    return true;
  }

  raycastSegment(origin, target, extraTargets = []) {
    const direction = new THREE.Vector3().subVectors(target, origin);
    const distance = direction.length();
    if (distance < 0.01) return null;
    const world = this.collision.raycast(origin, direction, distance);
    let best = world ? { point: world.point, normal: world.normal, distance: world.distance, object: null } : null;
    if (extraTargets.length) {
      this.raycaster.set(origin, direction.normalize());
      this.raycaster.far = distance;
      const hit = this.raycaster.intersectObjects(extraTargets, false)[0] ?? null;
      if (hit && (!best || hit.distance < best.distance)) best = hit;
    }
    return best;
  }

  findCoverPosition(origin, threat, navigation = this.navigation) {
    let best = null;
    let bestScore = Infinity;

    // Fix the 2-3 second freeze: Only check the closest 15 cover colliders.
    // Iterating and doing A* pathfinding over thousands of meshes on a large map kills the CPU!
    const candidates = this.coverColliders
      .map(collider => ({ collider, distSq: origin.distanceToSquared(collider.center) }))
      .sort((a, b) => a.distSq - b.distSq)
      .slice(0, 15)
      .map(item => item.collider);

    for (const collider of candidates) {
      if (collider.size.y > 3.4) continue;
      const towardCover = new THREE.Vector3().subVectors(collider.center, threat);
      towardCover.y = 0;
      if (towardCover.lengthSq() < 0.01) continue;
      towardCover.normalize();

      const reach = Math.max(collider.size.x, collider.size.z) * 0.5;
      const base = collider.center.clone().addScaledVector(towardCover, reach + 1.25);
      // Stand on the real surface rather than an assumed flat plane, otherwise
      // cover points end up buried in or floating over the ground.
      const baseGround = this.collision.groundHeight(base.x, base.z, 0.5, base.y + 1.5, 4);
      base.y = (Number.isFinite(baseGround) ? baseGround : this.floorY) + 0.04;
      const tangent = new THREE.Vector3(-towardCover.z, 0, towardCover.x);
      const peekA = base.clone().addScaledVector(tangent, 1.75);
      const peekB = base.clone().addScaledVector(tangent, -1.75);
      for (const peek of [peekA, peekB]) {
        const peekGround = this.collision.groundHeight(peek.x, peek.z, 0.5, peek.y + 1.5, 4);
        peek.y = (Number.isFinite(peekGround) ? peekGround : this.floorY) + 0.04;
      }
      const threatPoint = threat.clone().add(new THREE.Vector3(0, 1.1, 0));
      if (this.isSegmentClear(base.clone().add(new THREE.Vector3(0, 1.2, 0)), threatPoint)) continue;
      if (navigation && !navigation.isWalkablePoint(base)) continue;
      if (!this.canPlayerOccupy(base, 0.5, 1.85, null, 0.4)) continue;
      if (navigation && navigation.findPath(origin, base).length === 0
        && origin.distanceTo(base) > 1.2) continue;
      const peekCandidates = [peekA, peekB].filter((candidate) => (
        (!navigation || navigation.isWalkablePoint(candidate))
        && this.canPlayerOccupy(candidate, 0.5, 1.85, null, 0.4)
        && this.isSegmentClear(candidate.clone().add(new THREE.Vector3(0, 1.45, 0)), threatPoint)
      ));
      if (!peekCandidates.length) continue;
      const peek = peekCandidates[0];
      const distanceScore = origin.distanceTo(base) * 0.8 + base.distanceTo(threat) * 0.15;
      if (distanceScore < bestScore) {
        bestScore = distanceScore;
        best = { position: base, peek, collider };
      }
    }
    return best;
  }

  update(delta, elapsed) {
    this.clouds.forEach((cloud, index) => {
      cloud.position.x += delta * (0.28 + (index % 3) * 0.04);
      if (cloud.position.x > 75) cloud.position.x = -75;
    });
    this.scene.fog.color.offsetHSL(0, 0, Math.sin(elapsed * 0.05) * 0.0004);
  }
}

function smallStepCount(height) {
  return Math.ceil(height / 0.53);
}

function indexSeed(value) {
  return (Math.abs(Math.sin(value * 12.9898) * 43758.5453) % 1);
}