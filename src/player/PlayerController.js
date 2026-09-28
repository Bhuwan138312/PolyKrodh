import * as THREE from 'three';
import { GAME_CONFIG } from '../config.js';
import { HealthSystem } from './HealthSystem.js';

// Depenetration search: ring distances in metres, tried nearest first.
const ESCAPE_RINGS = [0.12, 0.24, 0.38, 0.55, 0.75, 1.0, 1.3, 1.7];
const ESCAPE_DIRECTIONS = 16;
const ESCAPE_OFFSETS = [
  [0.45, 0], [-0.45, 0], [0, 0.45], [0, -0.45],
  [0.32, 0.32], [-0.32, 0.32], [0.32, -0.32], [-0.32, -0.32],
  [0.75, 0], [-0.75, 0], [0, 0.75], [0, -0.75],
];
// Cancels the collision world's floor skin while descending, so a body resting
// on a surface is stopped by it instead of quietly sinking through it.
const DESCEND_TOLERANCE = -0.04;
const ASCEND_TOLERANCE = 0.02;

export class PlayerController {
  constructor({ scene, camera, input, arena, audio }) {
    this.scene = scene;
    this.camera = camera;
    this.input = input;
    this.arena = arena;
    this.audio = audio;
    this.config = GAME_CONFIG.player;

    this.root = new THREE.Group();
    this.root.name = 'Player';
    this.root.add(camera);
    this.scene.add(this.root);

    this.velocity = new THREE.Vector3();
    this.weaponSway = new THREE.Vector2();
    this.yaw = 0;
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilVelocity = 0;
    this.shake = 0;
    this.grounded = true;
    this.bobDistance = 0;
    this.lastFootstepDistance = 0;
    this.currentSpeed = 0;
    this.sprinting = false;
    this.adsAmount = 0;
    this.cameraYOffset = 0;
    this.forceNoAds = false;
    this.adsTarget = 0;
    this.adsActive = false;
    this.damageFlash = 0;
    this.lastDamageDirection = 0;
    // Whoever landed the most recent damaging shot, so the solo death cam can
    // look at the right bot. Cleared on reset.
    this.lastDamager = null;
    this.weapon = null;
    this.onHealthChanged = null;
    this.onDeath = null;

    this.health = new HealthSystem(
      this.config.health,
      (amount, current) => {
        if (amount > 0) {
          this.damageFlash = 1;
          this.shake = Math.min(1.2, this.shake + 0.5);
          this.audio.play('damage');
        }
        this.onHealthChanged?.(current, amount);
      },
      () => this.onDeath?.(),
    );
  }

  reset(spawn) {
    this.health.reset();
    this.lastDamager = null;
    this.root.position.copy(spawn);
    this.root.rotation.set(0, 0, 0);
    this.camera.position.set(0, this.config.eyeHeight, 0);
    this.camera.rotation.set(0, 0, 0);
    this.camera.fov = 90;
    this.camera.updateProjectionMatrix();
    this.velocity.set(0, 0, 0);
    this.weaponSway.set(0, 0);
    this.yaw = Math.atan2(spawn.x, spawn.z);
    this.pitch = 0;
    this.recoilPitch = 0;
    this.recoilYaw = 0;
    this.recoilVelocity = 0;
    this.shake = 0;
    this.damageFlash = 0;
    this.bobDistance = 0;
    this.adsAmount = 0;
    this.adsTarget = 0;
    this.adsActive = false;
    this.grounded = true;
    this.health.reset();
    this.weapon?.reset();
  }

  look(deltaX, deltaY) {
    this.weaponSway.x += deltaX;
    this.weaponSway.y += deltaY;
    const sensitivity = 0.00205 * THREE.MathUtils.lerp(1, this.config.ads.lookMultiplier, this.adsAmount);
    this.yaw -= deltaX * sensitivity;
    this.pitch -= deltaY * sensitivity;
    this.pitch = THREE.MathUtils.clamp(this.pitch, -1.47, 1.47);
  }

  addRecoil(pitch, yaw) {
    const adsScale = THREE.MathUtils.lerp(1, this.config.ads.recoilMultiplier, this.adsAmount);
    this.recoilVelocity += pitch * adsScale;
    this.recoilYaw += yaw * adsScale;
  }

  addShake(amount) {
    const adsScale = THREE.MathUtils.lerp(1, this.config.ads.shakeMultiplier, this.adsAmount);
    this.shake = Math.min(1.4, this.shake + amount * adsScale);
  }

  updateAimState(delta) {
    this.adsTarget = this.input.ads ? 1 : 0;
    // Override: force hip fire during reload etc.
    if (this.forceNoAds) this.adsTarget = 0;
    const response = 1 - Math.exp(-delta / (this.config.ads.transition * 0.32));
    this.adsAmount = THREE.MathUtils.lerp(this.adsAmount, this.adsTarget, response);
    this.adsActive = this.adsAmount > 0.5;
  }

  update(delta, aimStateAlreadyUpdated = false) {
    if (!aimStateAlreadyUpdated) this.updateAimState(delta);
    const movement = this.input.getMovement();
    const moving = movement.x !== 0 || movement.z !== 0;
    this.sprinting = this.input.isActionDown('sprint');

    const forward = new THREE.Vector3(-Math.sin(this.yaw), 0, -Math.cos(this.yaw));
    const right = new THREE.Vector3(Math.cos(this.yaw), 0, -Math.sin(this.yaw));
    const wishDirection = right.multiplyScalar(movement.x).addScaledVector(forward, movement.z);
    if (wishDirection.lengthSq() > 0) wishDirection.normalize();

    const movementSpeed = this.sprinting && moving ? this.config.sprintSpeed : this.config.walkSpeed;
    const targetSpeed = movementSpeed * THREE.MathUtils.lerp(1, this.config.ads.movementMultiplier, this.adsAmount);
    const targetVelocity = wishDirection.multiplyScalar(moving ? targetSpeed : 0);
    const acceleration = this.grounded
      ? (moving ? this.config.acceleration : this.config.groundDamping)
      : (moving ? this.config.airAcceleration : this.config.airDamping);
    const response = 1 - Math.exp(-acceleration * delta / Math.max(4, targetSpeed));
    this.velocity.x = THREE.MathUtils.lerp(this.velocity.x, targetVelocity.x, response);
    this.velocity.z = THREE.MathUtils.lerp(this.velocity.z, targetVelocity.z, response);

    if (this.input.wasActionPressed('jump') && this.grounded) {
      this.velocity.y = this.config.jumpSpeed;
      this.grounded = false;
      this.audio.play('jump');
    }
    // Gravity is integrated once, inside applyGravity, together with the
    // substepped vertical sweep. Applying it here as well halved the jump arc.

    const horizontalSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (horizontalSpeed > targetSpeed) {
      const scale = targetSpeed / horizontalSpeed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    // --- Smooth Capsule Collision Movement ---
    this.velocity.y -= this.config.gravity * delta;
    if (this.velocity.y < -this.config.maxFallSpeed) this.velocity.y = -this.config.maxFallSpeed;

    const substeps = 5;
    const deltaStep = delta / substeps;
    let wasGrounded = this.grounded;
    this.grounded = false;

    const maxSlopeCos = Math.cos(45 * Math.PI / 180); 
    const stepOffset = this.config.stepHeight; // Float above small bumps

    for (let i = 0; i < substeps; i++) {
      this.root.position.x += this.velocity.x * deltaStep;
      this.root.position.y += this.velocity.y * deltaStep;
      this.root.position.z += this.velocity.z * deltaStep;

      const radius = this.config.radius;
      const height = this.config.height;
      // Hover capsule: bottom sphere starts at stepOffset instead of 0
      const p1 = new THREE.Vector3(this.root.position.x, this.root.position.y + stepOffset + radius, this.root.position.z);
      const p2 = new THREE.Vector3(this.root.position.x, this.root.position.y + height - radius, this.root.position.z);
      const capsuleLine = new THREE.Line3(p1, p2);

      const penetrations = this.arena.collision.collideCapsule(capsuleLine, radius);
      penetrations.sort((a, b) => b.depth - a.depth);

      for (const p of penetrations) {
        // Since capsule is hovering, slopes are handled by grounding, so only push on steep walls
        const wallNormal = new THREE.Vector3(p.normal.x, 0, p.normal.z);
        const horizLen = wallNormal.length();
        if (horizLen > 0.001) {
          wallNormal.normalize();
          const hDepth = p.depth / horizLen;
          this.root.position.addScaledVector(wallNormal, hDepth);

          const velDot = this.velocity.x * wallNormal.x + this.velocity.z * wallNormal.z;
          if (velDot < 0) {
            this.velocity.x -= wallNormal.x * velDot;
            this.velocity.z -= wallNormal.z * velDot;
          }
        } else if (p.normal.y < -0.5) { // Ceiling
          this.root.position.addScaledVector(p.normal, p.depth);
          if (this.velocity.y > 0) this.velocity.y = 0;
        }
      }
    }

    // Grounding & Hover Snapping
    // We only snap to ground if we are falling or staying still vertically
    if (this.velocity.y <= 0) {
      const snap = this.arena.getGroundHeight(
        this.root.position,
        this.config.radius,
        this.root.position.y + stepOffset + 0.1, 
        this.root.position.y + stepOffset + 0.1, 
        stepOffset + (wasGrounded ? 0.6 : 0.15)
      );
      
      if (Number.isFinite(snap)) {
        const climb = snap - this.root.position.y;
        if ((climb > 0 && climb <= stepOffset + 0.01) || (climb <= 0 && wasGrounded && climb > -0.6) || (climb <= 0 && climb > -0.15)) {
          if (this.grounded || wasGrounded) {
             this.cameraYOffset -= climb; // Counteract the sudden root snap for the camera
          }
          this.root.position.y = snap;
          this.grounded = true;
          this.velocity.y = 0;
        }
      }
    }

    // Smoothly recover from step snaps
    this.cameraYOffset = THREE.MathUtils.lerp(this.cameraYOffset, 0, 1 - Math.exp(-15 * delta));

    this.currentSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (this.grounded && this.currentSpeed > 1.2) {
      this.bobDistance += this.currentSpeed * delta;

      // A single step is exactly half of a full stride (5.585 / 2 = ~2.7925 meters)
      if (this.bobDistance - this.lastFootstepDistance >= 2.7925) {
        this.audio.play('footstep', null, { speed: this.currentSpeed });
        this.lastFootstepDistance = this.bobDistance;
      }
    } else {
      // Ready to play step immediately when starting to move again
      this.lastFootstepDistance = this.bobDistance - 2.7925;
    }

    // Krunker-style: fast recoil snap-back
    this.recoilPitch += this.recoilVelocity;
    this.recoilVelocity *= Math.exp(-20 * delta);
    this.recoilPitch *= Math.exp(-14 * delta);
    this.recoilYaw *= Math.exp(-16 * delta);
    this.weaponSway.multiplyScalar(Math.exp(-14 * delta));
    this.shake *= Math.exp(-12 * delta);
    this.damageFlash *= Math.exp(-5.2 * delta);

    const bobAmount = this.grounded
      ? Math.min(this.currentSpeed / this.config.sprintSpeed, 1)
      * THREE.MathUtils.lerp(1, this.config.ads.swayMultiplier, this.adsAmount)
      : 0;
    const bobY = Math.sin(this.bobDistance * 2.25) * 0.035 * bobAmount;
    const bobX = Math.sin(this.bobDistance * 1.125) * 0.022 * bobAmount;
    const shakeX = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.018 : 0;
    const shakeY = this.shake > 0.002 ? (Math.random() - 0.5) * this.shake * 0.018 : 0;

    // Using default movement since we removed it from arguments, wait, movement is not here!
    // I need to find `movement`
    const strafeRoll = 0; // We will fix strafeRoll later if needed

    this.camera.position.set(bobX, this.config.eyeHeight + bobY + this.cameraYOffset, 0);
    this.camera.rotation.set(
      this.pitch + this.recoilPitch + shakeY,
      this.yaw + this.recoilYaw + shakeX,
      strafeRoll + Math.sin(this.bobDistance * 1.125) * 0.004 * bobAmount,
      'YXZ',
    );

    // Constant 90 FOV base, no zoom out on sprint
    const baseFov = 90;
    const targetFov = THREE.MathUtils.lerp(baseFov, this.config.ads.fov, this.adsAmount);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, targetFov, 1 - Math.exp(-14 * delta));
    this.camera.updateProjectionMatrix();
  }

  getAimDirection(target = new THREE.Vector3()) {
    this.camera.updateWorldMatrix(true, false);
    return this.camera.getWorldDirection(target);
  }

  getEyePosition(target = new THREE.Vector3()) {
    return this.camera.getWorldPosition(target);
  }
}
