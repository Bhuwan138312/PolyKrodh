import * as THREE from 'three';

const FORWARD_AXIS = new THREE.Vector3(0, 1, 0);
const RIGHT_AXIS = new THREE.Vector3(1, 0, 0);
const UP_AXIS = new THREE.Vector3(0, 0, 1);

export class WeaponProjectileSystem {
  constructor({
    scene,
    getTargets,
    onImpact,
    isValidHit,
    traceShot = null,
    maxActive = 64,
    radius = 0.009,
    maxStepDistance = 2.5,
  }) {
    this.scene = scene;
    this.getTargets = getTargets;
    this.onImpact = onImpact;
    this.isValidHit = isValidHit;
    // Solid, double sided world trace. Using this instead of a plain
    // three.js raycast is what stops bullets from escaping through walls, and
    // from tunnelling out when the muzzle is buried inside geometry.
    this.traceShot = traceShot;
    this.maxActive = maxActive;
    this.maxStepDistance = Math.max(0.25, maxStepDistance);
    this.projectiles = [];
    this.nextId = 1;
    this.warnedEmptyTargets = false;
    this.activeLights = 0;
    this.maxLights = 3;
    this.template = null;
    this.templateScale = new THREE.Vector3(1, 1, 1);
    this.raycaster = new THREE.Raycaster();
    this.raycaster.near = 0;
    this.raycaster.firstHitOnly = true;
    this.geometry = new THREE.CylinderGeometry(radius * 0.8, radius * 2.5, 0.24, 6, 1, true);
    this.material = new THREE.MeshBasicMaterial({
      color: 0xffffff, // White-hot core
      transparent: true,
      opacity: 0.95,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending
    });

    this.glowGeometry = new THREE.CylinderGeometry(radius * 3, radius * 12, 0.35, 6, 1, true);
    this.glowMaterial = new THREE.MeshBasicMaterial({
      color: 0xff6611, // Fiery orange trail
      transparent: true,
      opacity: 0.6,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending
    });

    // Pellet look: a small low-poly chip with a short faint streak. A shotgun
    // puts eight of these in the air at once, so they stay deliberately plain
    // and dim instead of using the rifle's bright tracer + glow.
    this.pelletGeometry = new THREE.OctahedronGeometry(radius * 1.9, 0);
    this.pelletMaterial = new THREE.MeshBasicMaterial({
      color: 0xffe0b4,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
      toneMapped: false,
    });
    this.pelletStreakGeometry = new THREE.CylinderGeometry(radius * 0.4, radius * 0.7, 0.07, 5, 1, true);
    this.pelletStreakMaterial = new THREE.MeshBasicMaterial({
      color: 0xffcf94,
      transparent: true,
      opacity: 0.4,
      depthWrite: false,
      toneMapped: false,
      blending: THREE.AdditiveBlending,
    });
  }

  setTemplate(template, worldScale = null) {
    this.template = template?.isObject3D ? template : null;
    if (worldScale) this.templateScale.copy(worldScale);
    if (this.template) this.template.visible = false;
  }

  fire({
    origin,
    direction,
    speed,
    range,
    spread = 0,
    length = 0.24,
    style = 'tracer',
    damage = null,
    headDamage = null,
    originRef = null,
  }) {
    while (this.projectiles.length >= this.maxActive) this.removeProjectile(this.projectiles[0]);

    const shotDirection = direction.clone().normalize();
    if (spread > 0) {
      const rotation = new THREE.Quaternion().setFromUnitVectors(FORWARD_AXIS, shotDirection);
      const right = RIGHT_AXIS.clone().applyQuaternion(rotation);
      const up = UP_AXIS.clone().applyQuaternion(rotation);
      shotDirection
        .addScaledVector(right, (Math.random() - 0.5) * spread * 2)
        .addScaledVector(up, (Math.random() - 0.5) * spread * 2)
        .normalize();
    }

    const visual = this.createProjectileVisual(shotDirection, length, style);
    if (!visual) {
      console.warn('[WeaponProjectileSystem] Projectile visual creation failed.');
      return null;
    }

    visual.position.copy(origin);
    visual.quaternion.setFromUnitVectors(FORWARD_AXIS, shotDirection);
    this.scene.add(visual);
    if (visual.parent !== this.scene) {
      console.warn('[WeaponProjectileSystem] Projectile was not added to the active scene.');
      return null;
    }

    // `damage` is this projectile's own share of the weapon's damage. A
    // shotgun pellet carries a fraction of the blast and lands on its own, so
    // several pellets on one target add up and a lone pellet never kills.
    const projectile = {
      id: this.nextId++,
      mesh: visual,
      direction: shotDirection,
      speed,
      remainingRange: range,
      active: true,
      style,
      damage,
      headDamage,
      originRef: originRef ?? origin.clone(),
    };
    this.projectiles.push(projectile);
    return projectile;
  }

  createProjectileVisual(direction, length, style = 'tracer') {
    const visual = new THREE.Group();
    if (style === 'pellet') {
      const pellet = new THREE.Mesh(this.pelletGeometry, this.pelletMaterial);
      const streak = new THREE.Mesh(this.pelletStreakGeometry, this.pelletStreakMaterial);
      streak.position.y = -0.03;
      visual.add(pellet, streak);

      visual.traverse((child) => {
        child.frustumCulled = false;
        if (child.isMesh) {
          child.castShadow = false;
          child.receiveShadow = false;
        }
      });
      return visual;
    }

    if (this.template) {
      const templateClone = this.template.clone(true);
      templateClone.visible = true;
      templateClone.position.set(0, 0, 0);
      templateClone.quaternion.identity();
      templateClone.scale.copy(this.templateScale);
      visual.add(templateClone);
    }

    const tracer = new THREE.Mesh(this.geometry, this.material);
    tracer.position.y = -length * 0.48;
    tracer.scale.y = length / 0.24;

    const glow = new THREE.Mesh(this.glowGeometry, this.glowMaterial);
    glow.position.y = -length * 0.45;
    glow.scale.y = length / 0.24;

    visual.add(tracer, glow);

    visual.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
    return visual;
  }

  update(delta) {
    if (!this.projectiles.length || delta <= 0) return;

    let targets = [];
    try {
      targets = this.getTargets?.() ?? [];
    } catch (error) {
      console.warn('[WeaponProjectileSystem] Failed to acquire collision targets.', error);
      return;
    }
    const usesWorldTrace = typeof this.traceShot === 'function';
    if (!targets.length && !this.warnedEmptyTargets) {
      console.warn('[WeaponProjectileSystem] No projectile collision targets are available.');
      this.warnedEmptyTargets = true;
    }

    for (let index = this.projectiles.length - 1; index >= 0; index -= 1) {
      const projectile = this.projectiles[index];
      let frameTravel = Math.min(projectile.speed * delta, projectile.remainingRange);

      while (projectile.active && frameTravel > 0.0001) {
        const travel = Math.min(frameTravel, this.maxStepDistance);
        const start = projectile.mesh.position;
        const end = start.clone().addScaledVector(projectile.direction, travel);
        let intersection = null;

        try {
          // Static world first: it is the only thing that can be solid from
          // both sides, so a shot can never pass through a building.
          if (usesWorldTrace) {
            const worldHit = this.traceShot(start, projectile.direction, travel);
            if (worldHit) {
              intersection = {
                point: worldHit.point,
                normal: worldHit.normal,
                distance: worldHit.distance,
                object: null,
                isWorld: true,
              };
            }
          }

          if (targets.length) {
            this.raycaster.set(start, projectile.direction);
            this.raycaster.far = usesWorldTrace && intersection
              ? Math.min(travel, intersection.distance)
              : travel;
            const dynamicHit = this.raycaster.intersectObjects(targets, false)
              .find((candidate) => this.isValidHit?.(candidate) ?? true) ?? null;
            if (dynamicHit && (!intersection || dynamicHit.distance < intersection.distance)) {
              intersection = dynamicHit;
            }
          }

          if (!intersection && !usesWorldTrace) {
            this.raycaster.set(start, projectile.direction);
            this.raycaster.far = travel;
            intersection = this.raycaster.intersectObjects(targets, false)
              .find((candidate) => this.isValidHit?.(candidate) ?? true) ?? null;
          }
        } catch (error) {
          console.warn(`[WeaponProjectileSystem] Collision raycast failed for shot ${projectile.id}.`, error);
          this.removeProjectile(projectile);
          break;
        }

        if (intersection) {
          try {
            this.onImpact?.(intersection, projectile.direction, projectile);
          } catch (error) {
            console.warn(`[WeaponProjectileSystem] Impact handling failed for shot ${projectile.id}.`, error);
          }
          this.removeProjectile(projectile);
          break;
        }

        projectile.mesh.position.copy(end);
        projectile.remainingRange -= travel;
        frameTravel -= travel;
      }

      if (projectile.active && projectile.remainingRange <= 0.0001) this.removeProjectile(projectile);
    }
  }

  removeProjectile(projectile) {
    if (!projectile.active) return;
    projectile.active = false;
    const index = this.projectiles.indexOf(projectile);
    if (index >= 0) this.projectiles.splice(index, 1);
    this.scene.remove(projectile.mesh);
  }

  clear() {
    for (const projectile of [...this.projectiles]) this.removeProjectile(projectile);
    this.projectiles.length = 0;
    this.warnedEmptyTargets = false;
  }
}
