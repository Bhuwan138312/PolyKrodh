import * as THREE from 'three';
import { BOT_TYPES } from '../config.js';
import { HealthSystem } from '../player/HealthSystem.js';
import { buildMinecraftCharacter, getBotSkin } from '../characters/MinecraftCharacter.js';

export const BotState = Object.freeze({
  IDLE: 'IDLE',
  PATROL: 'PATROL',
  SEARCH: 'SEARCH',
  CHASE: 'CHASE',
  ATTACK: 'ATTACK',
  TAKE_COVER: 'TAKE_COVER',
  DEAD: 'DEAD',
});

export class EnemyAI {
  constructor({ scene, arena, navigation, effects, audio, type, spawn, difficulty, id, coverClaims, onDeath, mapName }) {
    this.scene = scene;
    this.arena = arena;
    this.navigation = navigation;
    this.effects = effects;
    this.audio = audio;
    this.typeKey = type;
    this.type = BOT_TYPES[type];
    this.difficulty = difficulty;
    this.id = id;
    this.coverClaims = coverClaims ?? new Map();
    this.onDeath = onDeath;
    // The small arena uses the Minecraft-style blocky character; other maps
    // keep the legacy low-poly model.
    this.mapName = mapName ?? 'arena';
    this.style = this.mapName === 'smallarena' ? 'minecraft' : 'legacy';

    this.root = new THREE.Group();
    this.root.name = `${this.type.name}-${id}`;
    this.root.position.copy(spawn);
    this.root.rotation.y = spawnRotation(spawn);
    this.scene.add(this.root);

    this.state = BotState.IDLE;
    this.idleTimer = 0.8 + Math.random() * 1.4;
    this.patrolIndex = Math.floor(Math.random() * this.arena.patrolPoints.length);
    this.patrolTarget = this.arena.patrolPoints[this.patrolIndex].clone();
    this.lastKnownPlayer = spawn.clone();
    this.combatTarget = spawn.clone();
    this.path = [];
    this.pathTarget = new THREE.Vector3(9999, 0, 9999);
    this.repathTimer = 0;
    this.repositionTimer = 0;
    this.strafeSign = Math.random() > 0.5 ? 1 : -1;
    this.walkPhase = Math.random() * Math.PI * 2;
    this.currentSpeed = 0;
    this.velocity = new THREE.Vector3();
    this.alerted = false;
    this.canSee = false;
    this.timeSinceSeen = 999;
    this.reactionRemaining = 0;
    this.fireCooldown = 0.4;
    this.burstRemaining = 0;
    this.burstCooldown = 0.3 + Math.random() * 0.5;
    this.thinkTimer = Math.random() * 0.16;
    this.hitFlash = 0;
    this.recoilKick = 0;
    this.dead = false;
    this.deathAge = 0;
    this.removed = false;
    this.muzzleTimer = 0;
    this.cover = null;
    this.climbRoute = null;
    this.climbIndex = 0;
    this.coverPhase = '';
    this.coverTimer = 0;
    this.coverAge = 0;
    this.coverValid = false;
    this.aimErrorScale = 1;

    this.buildModel();
    this.health = new HealthSystem(
      this.type.health,
      null,
      () => this.die(),
    );
    this.accuracy = THREE.MathUtils.clamp(
      randomBetween(this.type.accuracy) + difficulty.accuracy,
      0.58,
      0.88,
    );
    this.reactionDuration = randomBetween(this.type.reaction) * difficulty.reactionMultiplier;
    this.damageMultiplier = difficulty.damageMultiplier;
  }

  buildModel() {
    this.model = new THREE.Group();
    this.model.name = 'BotModel';
    this.root.add(this.model);

    if (this.style === 'minecraft') {
      this.buildMinecraftModel();
    } else {
      this.buildLegacyModel();
    }
    this.tagModelMeshes();
  }

  buildMinecraftModel() {
    const { texture, imageData } = getBotSkin(this.typeKey);
    const character = buildMinecraftCharacter({ texture, imageData });
    this.model.add(character.group);

    this.head = character.head;
    this.headOverlay = character.headOverlay;
    this.torso = character.torso;
    this.leftArm = character.leftArm;
    this.rightArm = character.rightArm;
    this.leftLeg = character.leftLeg;
    this.rightLeg = character.rightLeg;
    this.gun = character.gun;
    this.skinMaterial = character.skinMaterial;
    this.overlayMaterial = character.overlayMaterial;
    this.gunMaterial = character.gunMaterial;
    this.materials = character.materials;

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0.30, 1.02, -0.85);
    this.root.add(this.muzzle);
    this.muzzleFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.13, 0),
      new THREE.MeshBasicMaterial({ color: 0xffd24d, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.muzzleFlash.position.copy(this.muzzle.position);
    this.muzzleFlash.scale.z = 1.8;
    this.muzzleFlash.visible = false;
    this.root.add(this.muzzleFlash);
  }

  buildLegacyModel() {
    const bodyColor = new THREE.Color(this.type.color);
    this.bodyMaterial = new THREE.MeshStandardMaterial({
      color: bodyColor, roughness: 0.86, flatShading: true,
      emissive: 0x000000, emissiveIntensity: 0,
    });
    this.darkMaterial = new THREE.MeshStandardMaterial({
      color: 0x27343a, roughness: 0.78, metalness: 0.12, flatShading: true,
      emissive: 0x000000, emissiveIntensity: 0,
    });
    this.accentMaterial = new THREE.MeshStandardMaterial({
      color: this.type.accent, emissive: 0x111111, emissiveIntensity: 0.12,
      roughness: 0.62, metalness: 0.08, flatShading: true,
    });
    this.materials = [this.bodyMaterial, this.darkMaterial, this.accentMaterial];

    this.torso = this.mesh(new THREE.BoxGeometry(0.72, 0.78, 0.42), this.bodyMaterial, [0, 1.13, 0]);
    const chestPlate = this.mesh(new THREE.BoxGeometry(0.58, 0.48, 0.08), this.accentMaterial, [0, 1.18, -0.25]);
    const belt = this.mesh(new THREE.BoxGeometry(0.74, 0.16, 0.44), this.darkMaterial, [0, 0.72, 0]);
    this.head = this.mesh(new THREE.BoxGeometry(0.48, 0.48, 0.46), this.darkMaterial, [0, 1.78, 0]);
    this.mesh(new THREE.BoxGeometry(0.4, 0.1, 0.035), this.accentMaterial, [0, 1.8, -0.25]);
    this.mesh(new THREE.BoxGeometry(0.1, 0.1, 0.04), this.accentMaterial, [0, 1.8, -0.27]);
    this.leftArm = this.mesh(new THREE.BoxGeometry(0.2, 0.64, 0.22), this.bodyMaterial, [-0.46, 1.16, -0.12]);
    this.rightArm = this.mesh(new THREE.BoxGeometry(0.2, 0.62, 0.22), this.bodyMaterial, [0.46, 1.16, -0.1]);
    this.leftLeg = this.mesh(new THREE.BoxGeometry(0.26, 0.72, 0.29), this.darkMaterial, [-0.2, 0.36, 0]);
    this.rightLeg = this.mesh(new THREE.BoxGeometry(0.26, 0.72, 0.29), this.darkMaterial, [0.2, 0.36, 0]);
    this.gun = this.mesh(new THREE.BoxGeometry(0.14, 0.16, 0.75), this.darkMaterial, [0.27, 1.16, -0.45]);
    this.mesh(new THREE.BoxGeometry(0.08, 0.08, 0.22), this.accentMaterial, [0.27, 1.24, -0.69]);

    this.leftArm.rotation.x = -0.9;
    this.rightArm.rotation.x = -0.65;
    this.gun.rotation.x = 0.03;

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0.27, 1.16, -0.85);
    this.root.add(this.muzzle);
    this.muzzleFlash = new THREE.Mesh(
      new THREE.OctahedronGeometry(0.13, 0),
      new THREE.MeshBasicMaterial({ color: 0xff8057, transparent: true, opacity: 0.9, depthWrite: false }),
    );
    this.muzzleFlash.position.copy(this.muzzle.position);
    this.muzzleFlash.scale.z = 1.8;
    this.muzzleFlash.visible = false;
    this.root.add(this.muzzleFlash);
  }

  tagModelMeshes() {
    this.hitMeshes = [];
    this.model.traverse((child) => {
      child.userData.bot = this;
      child.userData.head = child === this.head || child === this.headOverlay;
      if (child.isMesh) {
        child.userData.weaponProjectileTarget = true;
        child.castShadow = true;
        child.receiveShadow = true;
        this.hitMeshes.push(child);
      }
    });
  }

  mesh(geometry, material, position) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.position.set(...position);
    this.model.add(mesh);
    return mesh;
  }

  update(delta, context) {
    if (this.dead) {
      this.updateDeath(delta);
      return;
    }

    this.thinkTimer -= delta;
    this.timeSinceSeen += delta;
    this.repathTimer -= delta;
    this.repositionTimer -= delta;
    this.fireCooldown -= delta;
    this.burstCooldown -= delta;
    this.muzzleTimer -= delta;
    this.muzzleFlash.visible = this.muzzleTimer > 0;

    if (this.thinkTimer <= 0) {
      this.thinkTimer = 0.14 + Math.random() * 0.1;
      this.updateAwareness(context);
    }

    this.reactionRemaining = Math.max(0, this.reactionRemaining - delta);
    this.updateCoverState(delta, context);
    if (!this.dead) this.updateBehavior(delta, context);
    this.updateCombat(delta, context);
    this.updateVisuals(delta);
  }

  updateAwareness(context) {
    const player = context.player;
    const playerPosition = player.root.position;
    const distance = this.root.position.distanceTo(playerPosition);
    const eye = this.root.position.clone().add(new THREE.Vector3(0, 1.65, 0));
    const playerChest = player.root.position.clone().add(new THREE.Vector3(0, 1.12, 0));
    const toPlayer = playerChest.clone().sub(eye).normalize();
    const forward = new THREE.Vector3(-Math.sin(this.root.rotation.y), 0, -Math.cos(this.root.rotation.y));
    const inCone = forward.dot(toPlayer) > (this.alerted && this.timeSinceSeen < 2.5 ? -0.25 : 0.05);
    const detected = distance <= this.type.detection && inCone
      && this.arena.isSegmentClear(eye, playerChest, this.arena.getDynamicHitMeshes(this));
    this.canSee = detected;

    if (detected) {
      this.lastKnownPlayer.copy(playerPosition);
      this.timeSinceSeen = 0;
      if (!this.alerted) {
        this.alerted = true;
        this.reactionRemaining = this.reactionDuration;
        this.burstCooldown = 0.15 + Math.random() * 0.25;
      }
    }

    if (this.state === BotState.TAKE_COVER) return;
    if (this.alerted) {
      if (detected) {
        const wasAttacking = this.state === BotState.ATTACK;
        const preferred = this.type.preferredRange;
        this.state = distance > preferred * 1.22 ? BotState.CHASE : BotState.ATTACK;
        if (this.state === BotState.ATTACK && (!wasAttacking || this.repositionTimer <= 0)) {
          this.chooseCombatPosition(context);
        }
      } else if (this.timeSinceSeen < 8) {
        this.state = BotState.SEARCH;
      } else {
        this.alerted = false;
        this.state = BotState.PATROL;
        this.patrolTarget.copy(this.arena.patrolPoints[this.patrolIndex]);
      }
    } else {
      this.state = this.state === BotState.IDLE ? BotState.IDLE : BotState.PATROL;
    }
  }

  updateBehavior(delta, context) {
    const player = context.player;
    if (this.state === BotState.IDLE) {
      this.idleTimer -= delta;
      this.root.rotation.y += Math.sin(context.elapsed * 0.65 + this.id) * delta * 0.38;
      if (this.idleTimer <= 0) {
        this.state = BotState.PATROL;
        this.patrolTarget.copy(this.arena.patrolPoints[this.patrolIndex]);
      }
      return;
    }

    if (this.state === BotState.PATROL) {
      if (this.root.position.distanceTo(this.patrolTarget) < 1.15) {
        this.patrolIndex = (this.patrolIndex + 1 + Math.floor(Math.random() * 2)) % this.arena.patrolPoints.length;
        this.patrolTarget.copy(this.arena.patrolPoints[this.patrolIndex]);
        this.path = [];
      }
      this.moveToward(this.patrolTarget, this.type.speed * 0.54, delta, 0.6);
      return;
    }

    if (this.state === BotState.SEARCH) {
      if (this.root.position.distanceTo(this.lastKnownPlayer) < 1.8) {
        this.lastKnownPlayer.copy(this.navigation.randomPointNear(this.lastKnownPlayer, 3, 8));
        this.path = [];
      }
      this.moveToward(this.lastKnownPlayer, this.type.speed * 0.78, delta, 1.0);
      return;
    }

    if (this.state === BotState.CHASE) {
      const target = this.canSee ? player.root.position : this.lastKnownPlayer;
      if (this.canSee && this.root.position.distanceTo(player.root.position) < this.type.preferredRange * 1.05) {
        this.state = BotState.ATTACK;
        this.chooseCombatPosition(context);
      } else {
        // A bot with a `chaseSpeed` (the 1v1 pro) only matches the player's
        // sprint while it actually has eyes on them; searching and
        // repositioning stay at a human walking pace.
        const speed = this.canSee && Number.isFinite(this.type.chaseSpeed)
          ? this.type.chaseSpeed
          : this.type.speed;
        this.moveToward(target, speed, delta, this.typeKey === 'aggressive' ? 0.9 : 1.3);
      }
      return;
    }

    if (this.state === BotState.ATTACK) {
      if (!this.canSee) {
        this.state = BotState.SEARCH;
        return;
      }
      if (this.repositionTimer <= 0) this.chooseCombatPosition(context);
      const targetDistance = this.combatTarget.distanceTo(this.root.position);
      if (targetDistance > 0.8) {
        this.moveToward(this.combatTarget, this.type.speed * (this.typeKey === 'defensive' ? 0.64 : 0.76), delta, 0.65, player.root.position);
      } else {
        this.strafeAround(context.player.root.position, delta, this.type.speed * 0.36);
        this.faceTarget(player.root.position, delta, 8);
      }
    }
  }

  chooseCombatPosition(context) {
    if (this.typeKey === 'defensive' && !this.cover && Math.random() < 0.2) {
      this.enterCover(context);
      if (this.cover) return;
    }
    const playerPosition = context.player.root.position;
    const distance = this.root.position.distanceTo(playerPosition);
    const preferred = this.type.preferredRange;
    this.repositionTimer = 1.35 + Math.random() * 1.45;
    this.strafeSign *= -1;

    if (playerPosition.y > 1.2) {
      this.combatTarget.copy(playerPosition);
    } else if (this.typeKey === 'aggressive' || distance > preferred * 1.25) {
      this.combatTarget.copy(playerPosition);
    } else if (distance < preferred * 0.62) {
      const away = this.root.position.clone().sub(playerPosition).setY(0).normalize();
      this.combatTarget.copy(playerPosition).addScaledVector(away, preferred * 0.72);
    } else {
      const playerCell = this.navigation.cellToWorld(
        this.navigation.worldToCell(playerPosition.x),
        this.navigation.worldToCell(playerPosition.z),
      );
      this.combatTarget.copy(this.navigation.randomPointNear(playerCell, preferred * 0.55, preferred + 4));
    }
  }

  moveAlongClimbRoute(route, target, speed, delta, stopDistance, faceTarget) {
    if (this.climbRoute !== route) {
      this.climbRoute = route;
      this.climbIndex = 0;
    }

    if (this.climbIndex === 0) {
      const approach = route[0];
      if (this.root.position.distanceTo(approach) > 0.8) {
        this.moveToward(approach, speed, delta, 0.55, faceTarget, true);
        return;
      }
      this.climbIndex = 1;
    }

    while (this.climbIndex < route.length) {
      const point = route[this.climbIndex];
      const dx = point.x - this.root.position.x;
      const dz = point.z - this.root.position.z;
      const horizontalDistance = Math.hypot(dx, dz);
      const nextPoint = route[this.climbIndex + 1];
      if (nextPoint && nextPoint.y > point.y + 0.1 && horizontalDistance < 0.6) {
        this.climbIndex += 1;
        continue;
      }
      if (horizontalDistance < 0.3 && Math.abs(point.y + 0.02 - this.root.position.y) < 0.1) {
        this.climbIndex += 1;
        continue;
      }
      const direction = new THREE.Vector3(dx, 0, dz);
      if (direction.lengthSq() < 0.001) break;
      direction.normalize();
      const step = Math.min(speed * delta, horizontalDistance);
      const previousY = this.root.position.y;
      this.root.position.y = point.y + 0.02;
      const beforeX = this.root.position.x;
      const beforeZ = this.root.position.z;
      this.arena.moveCircle(
        this.root.position,
        direction.x * step,
        direction.z * step,
        0.43,
        1.85,
        this,
      );
      const moved = Math.hypot(this.root.position.x - beforeX, this.root.position.z - beforeZ);
      if (moved < step * 0.2 && point.y > previousY) this.root.position.y = previousY;
      this.currentSpeed = moved / Math.max(delta, 0.001);
      if (faceTarget) this.faceTarget(faceTarget, delta, 9);
      else this.faceDirection(direction, delta, 9);
      return;
    }

    this.climbRoute = null;
    this.climbIndex = 0;
    this.moveToward(target, speed, delta, stopDistance, faceTarget);
  }

  moveWithAvoidance(direction, step) {
    const startX = this.root.position.x;
    const startZ = this.root.position.z;
    this.arena.moveCircle(
      this.root.position,
      direction.x * step,
      direction.z * step,
      0.43,
      1.85,
      this,
    );
    let moved = Math.hypot(this.root.position.x - startX, this.root.position.z - startZ);
    if (moved >= step * 0.2) return moved;

    for (const angle of [0.65, -0.65, 1.15, -1.15]) {
      const cosine = Math.cos(angle);
      const sine = Math.sin(angle);
      const alternate = new THREE.Vector3(
        direction.x * cosine - direction.z * sine,
        0,
        direction.x * sine + direction.z * cosine,
      );
      this.arena.moveCircle(
        this.root.position,
        alternate.x * step,
        alternate.z * step,
        0.43,
        1.85,
        this,
      );
      moved = Math.hypot(this.root.position.x - startX, this.root.position.z - startZ);
      if (moved >= step * 0.2) return moved;
    }
    return moved;
  }

  moveToward(target, speed, delta, stopDistance = 0.6, faceTarget = null, skipClimb = false) {
    if (!skipClimb) {
      if (this.root.position.y > 0.2 && (!target || target.y < 1.2)) {
        this.root.position.y = Math.max(0.08, this.root.position.y - 8 * delta);
        this.currentSpeed = 0;
        return;
      }
      const climbRoute = this.arena.findClimbRoute(this.root.position, target);
      if (climbRoute) {
        this.moveAlongClimbRoute(climbRoute, target, speed, delta, stopDistance, faceTarget);
        return;
      }
      this.climbRoute = null;
      this.climbIndex = 0;
      if (target.y > 1.2 && this.root.position.y > 1.2) {
        const direction = target.clone().sub(this.root.position).setY(0);
        if (direction.length() > 0.9) {
          direction.normalize();
          this.currentSpeed = this.moveWithAvoidance(direction, speed * 0.65 * delta) / Math.max(delta, 0.001);
          this.faceTarget(target, delta, 8);
        } else {
          this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, 0, 1 - Math.exp(-10 * delta));
          this.faceTarget(target, delta, 8);
        }
        return;
      }
    }
    const distance = this.root.position.distanceTo(target);
    if (distance <= stopDistance) {
      this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, 0, 1 - Math.exp(-12 * delta));
      return;
    }

    if (this.repathTimer <= 0 || this.pathTarget.distanceToSquared(target) > 5.5 || this.path.length === 0) {
      this.path = this.navigation.findPath(this.root.position, target);
      this.pathTarget.copy(target);
      this.repathTimer = 0.7 + Math.random() * 0.35;
    }

    while (this.path.length && this.root.position.distanceTo(this.path[0]) < 0.48) this.path.shift();
    if (!this.path.length) {
      if (this.navigation.isWalkablePoint(target)
        && this.arena.canPlayerOccupy(target, 0.43, 1.85, this, 0.4)) {
        const direct = target.clone().sub(this.root.position).setY(0);
        if (direct.lengthSq() > 0.0001) {
          direct.normalize();
          this.currentSpeed = this.moveWithAvoidance(direct, speed * delta) / Math.max(delta, 0.001);
          this.faceTarget(target, delta, 8);
          return;
        }
      }
      this.currentSpeed = THREE.MathUtils.lerp(this.currentSpeed, 0, 1 - Math.exp(-10 * delta));
      return;
    }
    const waypoint = this.path[0];
    const direction = waypoint.clone().sub(this.root.position).setY(0);
    if (direction.lengthSq() < 0.001) return;
    direction.normalize();
    const step = Math.min(speed * delta, distance);
    const actualMove = this.moveWithAvoidance(direction, step);
    this.currentSpeed = actualMove / Math.max(delta, 0.001);
    if (faceTarget) this.faceTarget(faceTarget, delta, 9);
    else this.faceDirection(direction, delta, 9);
  }

  strafeAround(target, delta, speed) {
    const direction = target.clone().sub(this.root.position).setY(0).normalize();
    const strafe = new THREE.Vector3(-direction.z, 0, direction.x).multiplyScalar(this.strafeSign);
    const beforeX = this.root.position.x;
    const beforeZ = this.root.position.z;
    this.arena.moveCircle(this.root.position, strafe.x * speed * delta, strafe.z * speed * delta, 0.43, 1.85, this);
    const move = Math.hypot(this.root.position.x - beforeX, this.root.position.z - beforeZ);
    this.currentSpeed = move / Math.max(delta, 0.001);
  }

  enterCover(context) {
    if (this.state === BotState.TAKE_COVER && this.cover) return;
    if (Math.random() > this.type.coverChance) return;
    const cover = this.arena.findCoverPosition(this.root.position, context.player.root.position, this.navigation);
    if (!cover) return;
    for (const [owner, position] of this.coverClaims) {
      if (owner !== this && owner.cover && position.distanceTo(cover.position) < 1.5) return;
    }
    this.cover = cover;
    this.coverClaims.set(this, cover.position);
    this.coverValid = true;
    this.coverPhase = 'toCover';
    this.coverAge = 0;
    this.state = BotState.TAKE_COVER;
    this.path = [];
  }

  updateCoverState(delta, context) {
    if (this.state !== BotState.TAKE_COVER || !this.cover) return;
    this.coverAge += delta;
    const base = this.cover.position;
    const baseDistance = this.root.position.distanceTo(base);
    if (this.coverAge > 5.2 || this.timeSinceSeen > 9) {
      this.leaveCover(context);
      return;
    }

    if (this.coverPhase === 'toCover') {
      this.moveToward(base, this.type.speed, delta, 0.7, context.player.root.position);
      if (baseDistance < 0.72) {
        this.coverPhase = 'hold';
        this.coverTimer = 0.42 + Math.random() * 0.28;
        this.path = [];
      }
    } else if (this.coverPhase === 'hold') {
      this.coverTimer -= delta;
      this.currentSpeed *= Math.exp(-12 * delta);
      if (this.coverTimer <= 0) {
        this.coverPhase = 'peek';
        this.path = [];
      }
    } else if (this.coverPhase === 'peek') {
      this.moveToward(this.cover.peek, this.type.speed * 0.8, delta, 0.6, context.player.root.position);
      if (this.root.position.distanceTo(this.cover.peek) < 0.7) {
        this.coverPhase = 'fire';
        this.coverTimer = 0.85 + Math.random() * 0.45;
      }
    } else if (this.coverPhase === 'fire') {
      this.coverTimer -= delta;
      this.currentSpeed *= Math.exp(-14 * delta);
      this.faceTarget(context.player.root.position, delta, 10);
      if (this.coverTimer <= 0) {
        this.coverPhase = 'return';
        this.path = [];
      }
    } else if (this.coverPhase === 'return') {
      this.moveToward(base, this.type.speed * 0.9, delta, 0.65, context.player.root.position);
      if (baseDistance < 0.72) {
        this.coverPhase = 'hold';
        this.coverTimer = 0.5;
      }
    }
  }

  leaveCover(context) {
    this.coverClaims.delete(this);
    this.cover = null;
    this.coverValid = false;
    this.coverPhase = '';
    this.path = [];
    this.state = this.canSee ? BotState.ATTACK : BotState.SEARCH;
    this.chooseCombatPosition(context);
  }

  updateCombat(delta, context) {
    if (this.burstRemaining <= 0 && this.burstCooldown <= 0) {
      this.burstRemaining = Math.round(randomBetween(this.type.burst));
    }
    if (this.burstRemaining <= 0 || this.fireCooldown > 0 || this.reactionRemaining > 0 || !this.canSee) return;
    if (this.root.position.distanceTo(context.player.root.position) > this.type.attackRange) return;
    if (this.state !== BotState.ATTACK && !(this.state === BotState.TAKE_COVER && this.coverPhase === 'fire')) return;

    this.shoot(context);
    this.burstRemaining -= 1;
    this.fireCooldown = randomBetween(this.type.fireInterval);
    if (this.burstRemaining <= 0) this.burstCooldown = randomBetween(this.type.fireInterval) * 1.5;
  }

  shoot(context) {
    const player = context.player;
    const origin = this.muzzle.getWorldPosition(new THREE.Vector3());
    const distance = this.root.position.distanceTo(player.root.position);
    const target = player.root.position.clone().add(new THREE.Vector3(0, 1.12, 0));
    const error = (1 - this.accuracy) * distance * 0.045;
    target.x += (Math.random() - 0.5) * error * 2;
    target.y += (Math.random() - 0.5) * error * 1.15;
    target.z += (Math.random() - 0.5) * error * 2;

    const obstruction = this.arena.raycastSegment(origin, target, this.arena.getDynamicHitMeshes(this));
    const lineClear = !obstruction;
    const actuallyHits = lineClear && Math.random() < this.accuracy;
    let end = target.clone();
    if (lineClear && !actuallyHits) {
      const miss = 0.35 + (1 - this.accuracy) * distance * 0.08;
      end.x += (Math.random() - 0.5) * miss * 2;
      end.y += (Math.random() - 0.5) * miss;
      end.z += (Math.random() - 0.5) * miss * 2;
    }
    if (obstruction) {
      end = obstruction.point;
      const normal = obstruction.face?.normal?.clone()
        .transformDirection(obstruction.object.matrixWorld)
        .normalize();
      this.effects.impact(end, normal, 'dust');
    }

    this.effects.tracer(origin, end, true);
    this.muzzleTimer = 0.055;
    this.muzzleFlash.rotation.z = Math.random() * Math.PI;
    this.audio.play('enemyShot', this.root.position);
    if (actuallyHits) {
      const damage = Math.round(randomBetween(this.type.damage) * this.damageMultiplier);
      // Record the shooter before applying damage: if this shot is the killing
      // blow, the death cam needs to know who to look at.
      player.lastDamager = this;
      player.health.damage(damage);
    }
  }

  takeDamage(amount, point, headshot, attackerPosition = null, context = null) {
    if (this.dead) return false;
    this.health.current = Math.max(0, this.health.current - amount);
    this.hitFlash = headshot ? 1.25 : 0.9;
    this.recoilKick = 1;
    if (attackerPosition) {
      this.lastKnownPlayer.copy(attackerPosition);
      this.timeSinceSeen = 0;
    }
    if (!this.alerted || !this.canSee) {
      this.alerted = true;
      this.reactionRemaining = this.reactionDuration;
    }
    if (this.health.current <= 0) {
      this.die();
      return true;
    }
    if (context) this.enterCover(context);
    return false;
  }

  die() {
    if (this.dead) return;
    this.dead = true;
    this.coverClaims.delete(this);
    this.cover = null;
    this.state = BotState.DEAD;
    this.health.dead = true;
    this.currentSpeed = 0;
    this.muzzleFlash.visible = false;
    this.effects.death(this.root.position);
    this.audio.play('death', this.root.position);
    this.onDeath?.(this);
  }

  updateVisuals(delta) {
    const walk = Math.min(this.currentSpeed / 3.5, 1);
    this.walkPhase += delta * (4.5 + this.currentSpeed * 1.5);
    const swing = Math.sin(this.walkPhase) * 0.52 * walk;

    if (this.style === 'minecraft') {
      this.leftLeg.rotation.x = swing;
      this.rightLeg.rotation.x = -swing;
      // Arms hang relaxed with a mild counter-swing; the right arm nudges
      // toward the rifle while recoil drives the gun and torso.
      this.leftArm.rotation.x = -0.08 - swing * 0.3;
      this.rightArm.rotation.x = 0.85 + swing * 0.12;
      this.gun.position.z = -0.42 + this.recoilKick * 0.08;
      this.torso.rotation.x = this.recoilKick * 0.08;
      this.recoilKick *= Math.exp(-10 * delta);
      this.hitFlash *= Math.exp(-7.5 * delta);

      const flashAmount = Math.min(this.hitFlash, 1);
      this.skinMaterial.emissiveIntensity = flashAmount * 0.9;
      if (this.overlayMaterial) this.overlayMaterial.emissiveIntensity = flashAmount * 0.9;
      this.gunMaterial.emissiveIntensity = flashAmount * 0.55;
      return;
    }

    this.leftLeg.rotation.x = swing;
    this.rightLeg.rotation.x = -swing;
    this.leftArm.rotation.x = -0.9 + swing * 0.08;
    this.rightArm.rotation.x = -0.65 - this.recoilKick * 0.12;
    this.gun.position.z = -0.45 + this.recoilKick * 0.08;
    this.torso.rotation.x = this.recoilKick * 0.08;
    this.recoilKick *= Math.exp(-10 * delta);
    this.hitFlash *= Math.exp(-7.5 * delta);

    const flashAmount = Math.min(this.hitFlash, 1);
    this.bodyMaterial.emissive.setRGB(flashAmount * 0.85, flashAmount * 0.12, flashAmount * 0.04);
    this.darkMaterial.emissive.setRGB(flashAmount * 0.62, flashAmount * 0.08, flashAmount * 0.03);
    this.accentMaterial.emissiveIntensity = 0.12 + flashAmount * 0.9;
  }

  updateDeath(delta) {
    this.deathAge += delta;
    const progress = Math.min(this.deathAge / 0.78, 1);
    const eased = 1 - (1 - progress) ** 3;
    this.model.rotation.z = eased * 1.42;
    this.model.position.y = -eased * 0.16;
    this.model.scale.setScalar(1 - eased * 0.08);
    this.muzzleFlash.visible = false;
    if (this.deathAge > 1.35) this.remove();
  }

  faceDirection(direction, delta, speed = 8) {
    const targetAngle = Math.atan2(-direction.x, -direction.z);
    this.root.rotation.y = angleLerp(this.root.rotation.y, targetAngle, 1 - Math.exp(-speed * delta));
  }

  faceTarget(target, delta, speed = 8) {
    const direction = target.clone().sub(this.root.position).setY(0);
    if (direction.lengthSq() > 0.001) this.faceDirection(direction.normalize(), delta, speed);
  }

  remove() {
    if (this.removed) return;
    this.removed = true;
    this.coverClaims.delete(this);
    this.scene.remove(this.root);
    const materials = new Set(this.materials.concat([this.muzzleFlash.material]));
    this.root.traverse((child) => {
      if (child.isMesh) child.geometry.dispose();
    });
    materials.forEach((material) => material.dispose());
  }
}

function randomBetween(range) {
  return THREE.MathUtils.lerp(range[0], range[1], Math.random());
}

function angleLerp(current, target, amount) {
  let difference = (target - current + Math.PI) % (Math.PI * 2) - Math.PI;
  if (difference < -Math.PI) difference += Math.PI * 2;
  return current + difference * amount;
}

function spawnRotation(position) {
  return Math.atan2(-(0 - position.x), -(0 - position.z));
}
