import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { GAME_CONFIG } from '../config.js';
import { GLBWeaponRig } from './GLBWeaponRig.js';
import { WeaponProjectileSystem } from './WeaponProjectileSystem.js';
import { ShellEjectionSystem } from './ShellEjectionSystem.js';
import { WeaponHands, SHELL_LOAD_BEAT } from './WeaponHands.js';

/**
 * The soldier (shoulder) hold: how far the viewmodel sits up and in from the
 * gun's own hip pose. This is the DEFAULT carry for every weapon - the gun
 * comes up onto the shoulder out of the box - and Q drops it back down to the
 * hip. Model +Z runs back toward the camera, so a negative z here pushes the
 * gun further away, not closer.
 *
 * It stays an OFFSET from each weapon's own hip placement rather than a second
 * absolute position, so the per-weapon tuning (how far forward the sniper has
 * to sit, how low the rifle rides) still describes the hip pose and the
 * shoulder hold inherits it.
 */
const SOLDER_FIRE_OFFSET = new THREE.Vector3(-0.06, 0.13, -0.07);

/**
 * How much further away the gun sits while aiming, relative to its own hip-fire
 * depth. The sight line has to recede, never come back toward the eye.
 *
 * This is a per-weapon option rather than a hardcoded constant so a gun can be
 * held further forward in hip fire without dragging its scoped view along with
 * it. It stays an OFFSET from the weapon's own hip depth either way, so the
 * failure this replaced - a single absolute depth that only suits one weapon -
 * cannot come back.
 */
const ADS_FORWARD_OFFSET = -0.07;

export class WeaponSystem {
  constructor({ scene, camera, player, arena, effects, audio, config, modelUrl, displayName, targetLength = 1.25, viewScale = 1.3, callbacks = {}, basePosition = new THREE.Vector3(0.18, -0.32, -0.48), modelRotationX = 0, modelRotationY = Math.PI / 2, modelRotationZ = 0, modelOffset = new THREE.Vector3(0, 0, 0), boltTravelOverride = null, fallbackTemplatesSource = null, adsForwardOffset = ADS_FORWARD_OFFSET, leftHandOffset = null, showRightHand = true }) {
    this.scene = scene;
    this.camera = camera;
    this.player = player;
    this.arena = arena;
    this.effects = effects;
    this.audio = audio;
    this.callbacks = callbacks;
    this.config = config;
    this.modelUrl = modelUrl;
    this.displayName = displayName;
    this.targetLength = targetLength;
    this.viewScale = viewScale;
    this.modelRotationX = modelRotationX;
    this.modelRotationY = modelRotationY;
    this.modelRotationZ = modelRotationZ;
    this.modelOffset = modelOffset;
    this.boltTravelOverride = boltTravelOverride;
    this.leftHandOffset = leftHandOffset;
    this.showRightHand = showRightHand;
    this.suppressorEnabled = false;
    this.suppressorParts = [];
    this.altViewEnabled = false;
    // Each weapon ships ONE tuned placement, its hip pose. The shoulder
    // ("soldier") hold - the default carry for every gun - is SOLDER_FIRE_OFFSET
    // up from it, and Q toggles back down to the hip.
    this.hipPosition = basePosition.clone();
    this.shoulderPosition = basePosition.clone().add(SOLDER_FIRE_OFFSET);
    // The default pose is the shoulder hold, so a match starts with the gun up
    // on the shoulder rather than hanging at the hip.
    this.defaultBasePosition = this.shoulderPosition.clone();
    // Q parks the viewmodel at the low hip carry. It is an offset from the
    // weapon's OWN placement rather than a second absolute position: a
    // hardcoded point only ever looked right for a gun sitting exactly where
    // the rifle sits, and any weapon placed further out - the sniper, held
    // well forward down the screen - got yanked backward toward the camera
    // instead.
    this.altBasePosition = this.hipPosition.clone();
    this.targetBasePosition = this.defaultBasePosition.clone();
    // The -0.06 yaw rides the shoulder hold, not the hip one: it compensates
    // for the 3D perspective distortion of a gun carried up and back from the
    // eye, so it still reads as straight rather than swung out to the right.
    this.defaultBaseRotation = new THREE.Euler(0.0, -0.06, 0.0);
    this.altBaseRotation = new THREE.Euler(0.0, 0.0, 0.0);
    this.targetBaseRotation = this.defaultBaseRotation.clone();
    this.fallbackTemplatesSource = fallbackTemplatesSource;
    // Index into config.scope.magnifications, for weapons that have a scope.
    // A weapon without one keeps this at 0 and is never asked for a zoom level.
    const scope = config.scope;
    this.scopeStep = scope ? THREE.MathUtils.clamp(scope.defaultStep ?? 0, 0, scope.magnifications.length - 1) : 0;
    this.input = player.input;
    this.magazine = this.config.magazineSize;
    this.reserve = this.config.reserveSize;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.fireCooldown = 0;
    this.dryCooldown = 0;
    this.flashTimer = 0;
    this.weaponKick = 0;
    this.spread = 0;
    this.adsAmount = 0;
    // Whether the scoped viewmodel is currently swapped out for the 2D overlay.
    // Latches, so it survives the frame the input sits on the threshold.
    this.viewmodelHidden = false;
    this.shotCounter = 0;
    this.sprintCarryAmount = 0;
    // Krunker-style: muzzle faces crosshair, natural slant from Z-tilt, offset right
    // Starts on the shoulder hold, not the hip pose, so the gun never visibly
    // rises into place on spawn or on a match reset.
    this.basePosition = this.defaultBasePosition.clone();
    // The sight line always sits further from the eye than the hip pose,
    // expressed as an offset from this weapon's OWN depth. A fixed absolute
    // depth here is what put the sniper's scope inside the camera: it is held
    // well forward in hip fire, so aiming at the rifle's fixed depth yanked it
    // back toward the player.
    this.adsForwardOffset = adsForwardOffset;
    this.adsPosition = new THREE.Vector3(0, -0.19, basePosition.z + adsForwardOffset);
    this.baseRotation = this.defaultBaseRotation.clone();
    this.adsRotation = new THREE.Euler(0.0, 0, 0);
    this.aimRaycaster = new THREE.Raycaster();
    this.aimRaycaster.near = 0;
    this.modelAsset = null;
    this.weaponRig = null;
    this.hands = null;
    this.weaponLight = null;
    this.referenceAudit = null;
    this.shotDiagnostics = {
      created: 0,
      failed: 0,
      impacts: 0,
      botHits: 0,
      lastOrigin: null,
      lastTarget: null,
      lastDirection: null,
      lastAds: false,
    };

    this.projectiles = new WeaponProjectileSystem({
      scene,
      getTargets: () => this.getCollisionTargets(),
      traceShot: (origin, direction, far) => this.arena.traceShot(origin, direction, far),
      // The projectile is passed straight through: a pellet has to reach the
      // impact handler with its own damage attached.
      onImpact: (intersection, direction, projectile) => this.handleProjectileImpact(intersection, direction, projectile),
      isValidHit: (intersection) => this.isValidProjectileHit(intersection),
      maxActive: this.config.mechanics.projectile.maxActive,
      radius: this.config.mechanics.projectile.radius,
      maxStepDistance: this.config.mechanics.projectile.maxStepDistance,
    });
    this.shells = new ShellEjectionSystem({
      scene,
      arena,
      config: this.config.mechanics.shell,
    });
    this.droppedMags = [];

    // Only the shotgun has `pellets`: one trigger pull becomes a fan of
    // projectiles, each landing its own damage, and its reload feeds shells
    // one at a time instead of swapping a magazine.
    this.pelletConfig = this.config.pellets ?? null;
    this.isShotgun = Boolean(this.pelletConfig);
    this.shellReloadSettings = this.config.mechanics.shellReload ?? null;
    this.shellPortPoint = new THREE.Vector3();
    this.shellPortDir = new THREE.Vector3(0, 0, -1);
    // The port in NDC, refreshed each frame from the live holder transform, so
    // the hand only reaches for it when the player can actually see it.
    this.shellPortProjected = new THREE.Vector3(0, 0, -1);
    this.shellReload = {
      needed: 0,
      inserted: 0,
      loaded: -1,
    };

    this.buildModel();
    this.addWeaponLighting();

    // The shotgun is pump-fed: holding the trigger keeps firing at its
    // fireInterval, it is not one shot per click.
    this.fireMode = this.isShotgun ? 'auto'
      : (this.displayName === 'Pistol' || this.config.singleShot) ? 'single'
        : 'auto';
    this.fireWasPressed = false;

    this.ready = this.loadConfiguredModel();
  }

  buildModel() {
    this.weaponHolder = new THREE.Group();
    this.weaponHolder.name = 'FirstPersonWeaponHolder_' + this.displayName;
    this.weaponHolder.position.copy(this.basePosition);
    this.weaponHolder.rotation.copy(this.baseRotation);
    this.weaponHolder.scale.setScalar(this.viewScale);
    this.camera.add(this.weaponHolder);

    this.model = new THREE.Group();
    this.model.name = 'WeaponModel';
    this.weaponHolder.add(this.model);

    const body = new THREE.MeshStandardMaterial({ color: 0x26343b, roughness: 0.55, metalness: 0.38, flatShading: true });
    const dark = new THREE.MeshStandardMaterial({ color: 0x111a1f, roughness: 0.72, metalness: 0.2, flatShading: true });
    const accent = new THREE.MeshStandardMaterial({ color: 0x5fd1ca, emissive: 0x123f42, emissiveIntensity: 0.45, roughness: 0.45 });
    const grip = new THREE.MeshStandardMaterial({ color: 0x2e3a35, roughness: 0.9, flatShading: true });

    this.addPart('Receiver', new THREE.BoxGeometry(0.16, 0.16, 0.46), body, [0, 0, -0.05]);
    this.addPart('Upper rail', new THREE.BoxGeometry(0.105, 0.055, 0.5), dark, [0, 0.105, -0.08]);
    this.addPart('Barrel', new THREE.CylinderGeometry(0.025, 0.032, 0.38, 7), dark, [0, 0.015, -0.43]).rotation.x = Math.PI / 2;
    this.addPart('Muzzle', new THREE.CylinderGeometry(0.043, 0.036, 0.13, 7), dark, [0, 0.015, -0.66]).rotation.x = Math.PI / 2;
    this.addPart('Stock', new THREE.BoxGeometry(0.13, 0.13, 0.28), body, [0, -0.015, 0.25]);
    this.addPart('Stock pad', new THREE.BoxGeometry(0.15, 0.18, 0.06), dark, [0, -0.025, 0.405]);
    this.addPart('Magazine', new THREE.BoxGeometry(0.105, 0.28, 0.15), dark, [0, -0.18, -0.01]).rotation.x = -0.12;
    this.addPart('Grip', new THREE.BoxGeometry(0.11, 0.23, 0.12), grip, [0, -0.15, 0.13]).rotation.x = -0.28;
    this.addPart('Foregrip', new THREE.BoxGeometry(0.09, 0.18, 0.1), grip, [0, -0.13, -0.29]).rotation.x = -0.12;
    this.addPart('Status light', new THREE.BoxGeometry(0.025, 0.035, 0.16), accent, [0.086, 0.015, -0.05]);
    this.addPart('Charge handle', new THREE.BoxGeometry(0.18, 0.035, 0.07), accent, [0, 0.1, 0.12]);

    // Hands removed for Krunker-style clean viewmodel

    this.muzzle = new THREE.Object3D();
    this.muzzle.position.set(0, 0.015, -0.735);
    this.model.add(this.muzzle);

    const flashOrange = new THREE.MeshBasicMaterial({ color: 0xff8833, transparent: true, opacity: 0.8, depthWrite: false });
    const flashWhite = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.95, depthWrite: false });

    this.flash = new THREE.Group();
    this.flash.position.copy(this.muzzle.position);

    // Removed spheres so the shape is purely triangular

    // Helper to create a perfectly flat, stretched 2D triangle pointing forward
    const createTriangleGeo = (width, length) => {
      const geo = new THREE.BufferGeometry();
      const vertices = new Float32Array([
        -width / 2, 0, 0,       // Left base
        width / 2, 0, 0,       // Right base
        0, 0, -length          // Sharp tip pointing forward (-Z)
      ]);
      geo.setAttribute('position', new THREE.BufferAttribute(vertices, 3));
      return geo;
    };

    const outerTriangleGeo = createTriangleGeo(0.24, 0.85);
    const innerTriangleGeo = createTriangleGeo(0.12, 0.65);

    // 4 stretched triangles for the X-shape star
    for (let i = 0; i < 4; i++) {
      const wrapper = new THREE.Group();
      wrapper.rotation.order = 'ZXY';
      wrapper.rotation.z = (Math.PI / 4) + (i * Math.PI / 2);
      wrapper.rotation.x = -0.12;

      // Flat 2D stretched triangle
      const outerProng = new THREE.Mesh(outerTriangleGeo, flashOrange);
      const innerProng = new THREE.Mesh(innerTriangleGeo, flashWhite);

      // Make them double-sided so they are visible from all angles
      flashOrange.side = THREE.DoubleSide;
      flashWhite.side = THREE.DoubleSide;

      wrapper.add(outerProng, innerProng);
      this.flash.add(wrapper);
    }

    // Reduce flash size for Pistol
    if (this.displayName === 'Pistol') {
      this.flash.scale.setScalar(0.4);
    }

    this.flash.visible = false;
    this.model.add(this.flash);


    this.model.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
  }

  addWeaponLighting() {
    // Intentionally left blank to remove the "torch" effect on walls.
  }

  loadConfiguredModel() {
    const loader = new GLTFLoader();
    return new Promise((resolve) => {
      loader.load(
        this.modelUrl,
        (gltf) => {
          try {
            this.installConfiguredModel(gltf.scene);
            resolve(true);
          } catch (error) {
            console.warn('Unable to prepare custom gun model; keeping fallback weapon.', error);
            resolve(false);
          }
        },
        undefined,
        () => {
          console.warn('Custom gun model failed to load; keeping fallback weapon.');
          resolve(false);
        },
      );
    });
  }

  installConfiguredModel(asset) {
    asset.rotation.x = this.modelRotationX;
    asset.rotation.y = this.modelRotationY;
    asset.rotation.z = this.modelRotationZ;
    asset.updateMatrixWorld(true);

    if (this.targetLength) {
      const bounds = new THREE.Box3().setFromObject(asset);
      const size = bounds.getSize(new THREE.Vector3());
      const longSide = Math.max(size.x, size.z);
      const scale = this.targetLength / Math.max(longSide, 0.001);
      asset.scale.setScalar(scale);
      asset.updateMatrixWorld(true);

      const scaledBounds = new THREE.Box3().setFromObject(asset);
      const center = scaledBounds.getCenter(new THREE.Vector3());
      asset.position.sub(center).add(this.modelOffset);
      asset.updateMatrixWorld(true);
    }

    if (this.displayName === 'SCAR') {
      // Hide the vertical foregrip attachment on the mesh
      const foregrip = asset.getObjectByName('Grip');
      if (foregrip) foregrip.visible = false;

      // Save references to suppressor parts
      this.suppressorParts = [];
      const suppressorNames = ['Supressor', 'Suppressor_Knotch', 'Suppressor_Notch'];
      for (const name of suppressorNames) {
        const part = asset.getObjectByName(name);
        if (part) {
          part.visible = this.suppressorEnabled;
          this.suppressorParts.push(part);
        }
      }
      this.suppressorPoint = asset.getObjectByName('Supressorpoint');
    }

    this.model.clear();
    this.model.name = this.displayName;
    this.model.add(asset);
    this.weaponRig = new GLBWeaponRig({
      model: this.model,
      asset,
      mechanics: this.config.mechanics,
      boltTravelOverride: this.boltTravelOverride,
    });
    this.referenceAudit = this.weaponRig.referenceAudit;

    if (this.fallbackTemplatesSource && this.fallbackTemplatesSource.weaponRig) {
      if (!this.weaponRig.references.bulletTemplate && this.fallbackTemplatesSource.weaponRig.references.bulletTemplate) {
        this.weaponRig.references.bulletTemplate = this.fallbackTemplatesSource.weaponRig.references.bulletTemplate;
        this.weaponRig.templateWorldScales.set(this.weaponRig.references.bulletTemplate, this.fallbackTemplatesSource.weaponRig.getTemplateWorldScale(this.weaponRig.references.bulletTemplate));
      }
      if (!this.weaponRig.references.shellTemplate && this.fallbackTemplatesSource.weaponRig.references.shellTemplate) {
        this.weaponRig.references.shellTemplate = this.fallbackTemplatesSource.weaponRig.references.shellTemplate;
        this.weaponRig.templateWorldScales.set(this.weaponRig.references.shellTemplate, this.fallbackTemplatesSource.weaponRig.getTemplateWorldScale(this.weaponRig.references.shellTemplate));
      }
    }

    this.projectiles.setTemplate(
      this.weaponRig.references.bulletTemplate,
      this.weaponRig.getTemplateWorldScale(this.weaponRig.references.bulletTemplate),
    );
    this.shells.setTemplate(
      this.weaponRig.references.shellModel ?? this.weaponRig.references.shellTemplate,
      this.weaponRig.getTemplateWorldScale(this.weaponRig.references.shellModel ?? this.weaponRig.references.shellTemplate),
    );
    this.model.updateWorldMatrix(true, true);

    const muzzlePoint = this.weaponRig.references.muzzlePoint;
    if (muzzlePoint) {
      const muzzlePosition = muzzlePoint.getWorldPosition(new THREE.Vector3());
      this.model.worldToLocal(muzzlePosition);
      this.muzzle.position.copy(muzzlePosition);

      const muzzleDirection = muzzlePoint.getWorldDirection(new THREE.Vector3());
      const inverseModelRotation = this.model.getWorldQuaternion(new THREE.Quaternion()).invert();
      muzzleDirection.applyQuaternion(inverseModelRotation).normalize();
      this.muzzle.quaternion.setFromUnitVectors(new THREE.Vector3(0, 0, -1), muzzleDirection);
    }

    this.flash.position.copy(this.muzzle.position);


    if (this.weaponRig.adsLocalPosition) {
      const adsOffset = this.weaponRig.adsLocalPosition.clone()
        .multiply(this.model.scale)
        .multiply(this.weaponHolder.scale)
        .applyEuler(this.adsRotation);
      this.adsPosition.set(-adsOffset.x, -adsOffset.y, this.adsPosition.z);
    }

    this.model.add(this.muzzle);
    this.model.add(this.flash);

    // Add Krunker-style blocky hands
    this.hands = new WeaponHands({
      model: this.model,
      asset,
      isPistol: this.targetLength < 0.5,
      displayName: this.displayName,
      leftHandOffset: this.leftHandOffset,
      showRightHand: this.showRightHand,
      fallbackHandsSource: this.fallbackTemplatesSource?.hands
    });

    // Wire magazine drop callback for physics throw
    if (this.weaponRig) {
      this.weaponRig.onMagazineDrop = (mag, pos, quat, scale) => this.dropMagazine(mag, pos, quat, scale);
    }
    this.addWeaponLighting();
    this.modelAsset = asset;
    this.model.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
  }

  addPart(name, geometry, material, position) {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.name = name;
    mesh.position.set(...position);
    this.model.add(mesh);
    return mesh;
  }

  reset() {
    this.magazine = this.config.magazineSize;
    this.reserve = this.config.reserveSize;
    this.reloading = false;
    this.reloadElapsed = 0;
    this.fireCooldown = 0;
    this.dryCooldown = 0;
    this.flashTimer = 0;
    this.weaponKick = 0;
    this.adsAmount = 0;
    this.shotCounter = 0;
    this.shotDiagnostics = {
      created: 0,
      failed: 0,
      impacts: 0,
      botHits: 0,
      lastOrigin: null,
      lastTarget: null,
      lastDirection: null,
      lastAds: false,
    };
    this.weaponRig?.reset();
    this.shellReload.needed = 0;
    this.shellReload.inserted = 0;
    this.shellReload.loaded = -1;
    // Drops any round still stuck to the fist and brings the support hand home,
    // so a reload cut off by a death does not follow the player into the next
    // match.
    this.hands?.resetShellLoad();
    this.clearTransientEffects();
    // Back to the default shoulder hold. The pose is a live lerp toward its
    // target, so a reset that landed while Q had the gun down at the hip would
    // otherwise carry that hip carry into the next match instead of starting
    // from the default the way the constructor does.
    this.altViewEnabled = false;
    this.basePosition.copy(this.defaultBasePosition);
    this.targetBasePosition.copy(this.defaultBasePosition);
    this.baseRotation.copy(this.defaultBaseRotation);
    this.targetBaseRotation.copy(this.defaultBaseRotation);
    this.weaponHolder.position.copy(this.basePosition);
    this.weaponHolder.rotation.copy(this.baseRotation);
    // Always restore the viewmodel on reset. update() hides it while a scope is
    // up, and a reset that happened mid-aim would otherwise leave the gun
    // invisible on the next spawn. The latch has to clear with it, or the next
    // aim would leave the holder hidden and the rising `visible = true` above
    // would be undone on the very next frame.
    this.viewmodelHidden = false;
    this.weaponHolder.visible = true;
    this.flash.visible = false;

    this.emitAmmo();
  }

  update(delta) {
    this.fireCooldown -= delta;
    this.dryCooldown -= delta;
    this.flashTimer -= delta;

    // Smoothly transition base position and rotation for alt view toggle
    const viewLerp = 1 - Math.exp(-12 * delta);
    this.basePosition.lerp(this.targetBasePosition, viewLerp);
    this.baseRotation.x = THREE.MathUtils.lerp(this.baseRotation.x, this.targetBaseRotation.x, viewLerp);
    this.baseRotation.y = THREE.MathUtils.lerp(this.baseRotation.y, this.targetBaseRotation.y, viewLerp);
    this.baseRotation.z = THREE.MathUtils.lerp(this.baseRotation.z, this.targetBaseRotation.z, viewLerp);

    // Krunker-style: fast snap-back recoil recovery
    this.weaponKick *= Math.exp(-22 * delta);
    this.adsAmount = THREE.MathUtils.clamp(this.player.adsAmount, 0, 1);
    // A scoped weapon hands the screen over to the 2D scope overlay in three
    // beats - a visible rifle raise, then the mask closing, then the viewmodel
    // dropped behind it. The thresholds are in config.ads.scopeOverlay.
    //
    // The viewmodel still has to be dropped at the end rather than left drawn:
    // at full aim the eye sits inside the scope tube, so a drawn viewmodel means
    // the tube's inner wall wraps around the viewfinder.
    //
    // The holder is hidden rather than the model, because model.visible is owned
    // by the weapon-switch code in Game.js; the two compose cleanly.
    if (this.config.scope) {
      const { viewmodelHiddenAt, viewmodelBackAt } = GAME_CONFIG.player.ads.scopeOverlay;
      // `viewmodelHiddenAt` is past `maskFull`, so the rifle is behind solid
      // black when it is dropped and cannot be seen going. It comes back at
      // `viewmodelBackAt`, which is `maskFull`, so it is restored while the
      // mask is still opaque and emerges as the vignette opens rather than
      // appearing in the open. The band between the two sits behind solid
      // black, so toggling inside it cannot flicker visibly. Weapons with no
      // scope are never touched.
      if (!this.viewmodelHidden && this.adsAmount > viewmodelHiddenAt) this.viewmodelHidden = true;
      else if (this.viewmodelHidden && this.adsAmount <= viewmodelBackAt) this.viewmodelHidden = false;
      this.weaponHolder.visible = !this.viewmodelHidden;
    } else {
      this.weaponHolder.visible = true;
    }
    this.weaponRig?.setAdsVisibility(this.adsAmount > 0.5);
    this.weaponRig?.update(delta);
    this.updateReload(delta);
    if (this.input.wasActionPressed('reload')) this.startReload();
    const movementFactor = Math.min(this.player.currentSpeed / this.player.config.sprintSpeed, 1);
    const adsSway = THREE.MathUtils.lerp(1, this.player.config.ads.swayMultiplier, this.adsAmount);
    const adsSpread = THREE.MathUtils.lerp(1, this.player.config.ads.spreadMultiplier, this.adsAmount);
    const targetSpread = (this.config.baseSpread
      + movementFactor * this.config.moveSpread
      + this.weaponKick * 0.015
      + this.shotCounter * 0.0008) * adsSpread;
    this.spread = THREE.MathUtils.lerp(this.spread, targetSpread, 1 - Math.exp(-18 * delta));
    // Decay shot counter when not firing
    if (!this.input.firing) this.shotCounter = Math.max(0, this.shotCounter - delta * 12);
    // A shotgun's crosshair has to show the cone the pellets actually fan out
    // through, which is far wider than the rifle's own aim jitter.
    this.callbacks.onSpread?.(this.spread + (this.pelletConfig ? this.pelletConfig.spread : 0));

    const reloadProgress = this.reloading ? this.reloadElapsed / this.getReloadDuration() : 0;
    // A shotgun loads tubes, not magazines, so it skips the mag-swap hand
    // animation and the mag-swap gun tilt entirely. It gets the tubular reload
    // instead - the hand feeding rounds into the model's own loading port - which
    // runs on its own clock below and is deliberately kept out of the mag-swap
    // path so the two can never half-apply.
    if (this.isShotgun) {
      this.updateShellLoadAnimation(delta);
    } else {
      this.hands?.updateReload(reloadProgress);
    }
    // No dedicated loading pose. The shotgun's cant comes from the shared tilt
    // below, so nothing extra is blended in here.
    // Reload animation: tilt gun LEFT, throw mag out, spawn new, return.
    // The shotgun shares this block, so it cants over exactly like the rifles
    // and the sniper rather than taking a pose of its own. It keeps the gun on
    // screen and in place, which is the whole point - the earlier dedicated pose
    // lifted and pushed the viewmodel forward and read as the weapon flying away
    // from the player.
    let reloadTiltZ = 0;
    let reloadTiltX = 0;
    let reloadOffsetY = 0;
    let reloadOffsetX = 0;
    if (this.reloading) {
      const p = reloadProgress;
      const sm = (t) => { const c = Math.min(Math.max(t, 0), 1); return c * c * (3 - 2 * c); };
      if (p < 0.15) {
        const t = sm(p / 0.15);
        reloadTiltZ = -t * 0.95;  // tilt LEFT
      } else if (p < 0.75) {
        // Hold tilted with subtle breathing motion so it doesn't feel frozen
        const breath = Math.sin(this.reloadElapsed * 4.5) * 0.02;
        reloadTiltZ = -0.95 + breath;
      } else {
        const t = sm((p - 0.75) / 0.25);
        reloadTiltZ = -(1 - t) * 0.95;  // return from left
      }
      reloadTiltX = Math.abs(reloadTiltZ) * -0.12;
      reloadOffsetY = Math.abs(reloadTiltZ) * -0.06;
      reloadOffsetX = reloadTiltZ * 0.08;  // shift left with tilt
    }

    // Sway and bob — amplified during reload for natural body movement
    const reloadSwayBoost = this.reloading ? 2.5 : 1;
    const lookSwayX = THREE.MathUtils.clamp(this.player.weaponSway?.x ?? 0, -1, 1)
      * THREE.MathUtils.lerp(0.05, 0.01, this.adsAmount); // Drastically reduced turning sway
    const lookSwayY = THREE.MathUtils.clamp(this.player.weaponSway?.y ?? 0, -1, 1)
      * THREE.MathUtils.lerp(0.05, 0.01, this.adsAmount); // Drastically reduced turning sway
    const sway = (Math.sin(this.player.bobDistance * 1.125) * 0.001 * movementFactor * adsSway
      + lookSwayX * 0.002) * reloadSwayBoost;
    const bob = (Math.sin(this.player.bobDistance * 2.25) * 0.0015 * movementFactor * adsSway
      - lookSwayY * 0.002) * reloadSwayBoost;
    // Running pitch pivot: barrel swings up and down
    const runTilt = 0;
    const runYaw = 0;
    const runPitch = Math.sin(this.player.bobDistance * 1.125) * 0.01 * movementFactor * adsSway;

    // Sprint carry: gun rotates into an angled hold while running, swings from that offset
    const isPistol = this.displayName === 'Pistol';
    const sprintTarget = (isPistol || this.input.firing) ? 0 : movementFactor * (1 - this.adsAmount);
    // Smooth blend: snap to idle when firing, smooth transition when stopping
    const carrySpeed = this.input.firing ? 25 : 8;
    this.sprintCarryAmount = THREE.MathUtils.lerp(this.sprintCarryAmount, sprintTarget, 1 - Math.exp(-carrySpeed * delta));
    const sprintBlend = this.sprintCarryAmount;
    const carryYaw = 0;
    const carryPitch = 0;
    const carryOffsetX = 0; // Removed horizontal shift when moving/sprinting
    const carryOffsetY = sprintBlend * -0.005; // Less drop

    // Krunker-style: snappy, tight recoil kick with fast recovery
    // Pistol gets a stronger upward muzzle tip to simulate light-frame recoil
    const kickScale = 1.0;
    const kickBackMultiplier = isPistol ? 0.12 : 0.18;   // less backward push for pistol
    const kickUpMultiplier = isPistol ? 0.38 : 0.22;     // more upward barrel tip for pistol

    // Angle the gun outward when suppressor is equipped to manage its visual length
    const suppressorYaw = this.suppressorEnabled ? THREE.MathUtils.lerp(-0.05, 0, this.adsAmount) : 0;
    const suppressorOffsetX = this.suppressorEnabled ? THREE.MathUtils.lerp(0.015, 0, this.adsAmount) : 0;

    this.weaponHolder.position.set(
      THREE.MathUtils.lerp(this.basePosition.x, this.adsPosition.x, this.adsAmount) + sway + reloadOffsetX + carryOffsetX + suppressorOffsetX,
      THREE.MathUtils.lerp(this.basePosition.y, this.adsPosition.y, this.adsAmount)
      + reloadOffsetY + bob + carryOffsetY,
      THREE.MathUtils.lerp(this.basePosition.z, this.adsPosition.z, this.adsAmount)
      + this.weaponKick * kickBackMultiplier * kickScale,
    );
    this.weaponHolder.rotation.set(
      THREE.MathUtils.lerp(this.baseRotation.x, this.adsRotation.x, this.adsAmount)
      - this.weaponKick * kickUpMultiplier * kickScale + reloadTiltX - lookSwayY * 0.003 + carryPitch + runPitch,
      THREE.MathUtils.lerp(this.baseRotation.y, this.adsRotation.y, this.adsAmount) + sway * 0.15 + runYaw + carryYaw + suppressorYaw,
      THREE.MathUtils.lerp(this.baseRotation.z, this.adsRotation.z, this.adsAmount) + reloadTiltZ + runTilt,
    );
    this.weaponHolder.updateMatrixWorld(true);
    // Resolved here, once the holder transform above is final, because that is
    // the transform the port's visibility depends on. Cached into a plain vector
    // rather than computed inside updateShellLoadAnimation, which runs earlier
    // and would be reading last frame's holder.
    if (this.isShotgun && this.shellPortPoint) {
      this.shellPortProjected = (this.shellPortProjected ?? new THREE.Vector3())
        .copy(this.shellPortPoint)
        .applyMatrix4(this.model.matrixWorld)
        .project(this.camera);
    }
    if (this.input.wasPressed('KeyB') && (this.displayName === 'M416' || this.displayName === 'SCAR')) {
      this.fireMode = this.fireMode === 'auto' ? 'single' : 'auto';
      this.audio.play('dry'); // small click sound
    }

    const fireAttempted = this.input.firing && (this.fireMode === 'auto' || !this.fireWasPressed);
    if (fireAttempted) {
      if (this.magazine > 0 || !this.fireWasPressed) {
        this.tryFire();
      }
    }
    this.fireWasPressed = this.input.firing;

    this.flash.visible = this.flashTimer > 0;
    if (this.flash.visible) {
      this.flash.rotation.z = Math.random() * Math.PI;
      let baseScale = this.displayName === 'Pistol' ? 0.35 : 0.78;
      let variance = this.displayName === 'Pistol' ? 0.2 : 0.45;

      if (this.suppressorEnabled) {
        baseScale *= 0.15; // Drastically reduce muzzle flash when suppressed
        variance *= 0.15;
      }

      this.flash.scale.setScalar(baseScale + Math.random() * variance);
    }
  }

  updateTransientEffects(delta) {
    this.projectiles.update(delta);
    this.shells.update(delta);
    this.updateDroppedMags(delta);
  }

  clearTransientEffects() {
    this.projectiles.clear();
    this.shells.clear();
    for (const mag of this.droppedMags) this.scene.remove(mag.mesh);
    this.droppedMags.length = 0;
  }

  dropMagazine(mag, worldPos, worldQuat, worldScale) {
    mag.position.copy(worldPos);
    mag.quaternion.copy(worldQuat);
    mag.scale.copy(worldScale);
    mag.visible = true;
    mag.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) { child.castShadow = false; child.receiveShadow = false; }
    });
    this.scene.add(mag);

    // Random throw direction — scattered, not uniform
    const camDir = this.camera.getWorldDirection(new THREE.Vector3());
    const camRight = new THREE.Vector3().crossVectors(camDir, new THREE.Vector3(0, 1, 0)).normalize();
    const throwSpeed = 2.5 + Math.random() * 1.5;
    const sideways = (Math.random() - 0.5) * 3.0;
    const upward = 1.0 + Math.random() * 1.5;
    const velocity = camDir.clone().multiplyScalar(throwSpeed)
      .addScaledVector(camRight, sideways)
      .addScaledVector(new THREE.Vector3(0, 1, 0), upward);

    this.droppedMags.push({
      mesh: mag,
      velocity,
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
        (Math.random() - 0.5) * 18,
      ),
      age: 0,
      bounces: 0,
      initialScale: mag.scale.clone(),
    });
  }

  updateDroppedMags(delta) {
    for (let i = this.droppedMags.length - 1; i >= 0; i--) {
      const mag = this.droppedMags[i];
      mag.age += delta;
      if (mag.age >= 3.0) {
        this.scene.remove(mag.mesh);
        this.droppedMags.splice(i, 1);
        continue;
      }
      // Shrink out in last second instead of fading to avoid material sharing bugs
      if (mag.age > 2.0) {
        const shrink = Math.max(0, 1 - (mag.age - 2.0));
        mag.mesh.scale.copy(mag.initialScale).multiplyScalar(shrink);
      }
      mag.velocity.y -= 12 * delta;
      const nextPos = mag.mesh.position.clone().addScaledVector(mag.velocity, delta);
      const ground = this.arena.getGroundHeight(
        mag.mesh.position,
        0.06,
        mag.mesh.position.y,
        nextPos.y,
        Math.max(3, Math.abs(mag.velocity.y) * delta + 0.5),
      );
      if (nextPos.y <= ground + 0.03 && mag.velocity.y < 0) {
        nextPos.y = ground + 0.03;
        if (mag.bounces < 2 && Math.abs(mag.velocity.y) > 0.5) {
          mag.velocity.y *= -0.2;
          mag.velocity.x *= 0.5;
          mag.velocity.z *= 0.5;
          mag.angularVelocity.multiplyScalar(0.6);
          mag.bounces++;
        } else {
          mag.velocity.set(0, 0, 0);
          mag.angularVelocity.multiplyScalar(Math.exp(-6 * delta));
        }
      }
      mag.mesh.position.copy(nextPos);
      mag.mesh.rotation.x += mag.angularVelocity.x * delta;
      mag.mesh.rotation.y += mag.angularVelocity.y * delta;
      mag.mesh.rotation.z += mag.angularVelocity.z * delta;
    }
  }

  toggleSuppressor() {
    if (this.suppressorParts && this.suppressorParts.length > 0) {
      this.suppressorEnabled = !this.suppressorEnabled;
      for (const part of this.suppressorParts) {
        part.visible = this.suppressorEnabled;
      }

      // Update muzzle position to be at the suppressor tip if enabled
      const activePoint = (this.suppressorEnabled && this.suppressorPoint)
        ? this.suppressorPoint
        : this.weaponRig?.references?.muzzlePoint;

      if (activePoint) {
        this.model.updateWorldMatrix(true, true);
        const position = activePoint.getWorldPosition(new THREE.Vector3());
        this.model.worldToLocal(position);
        this.muzzle.position.copy(position);
        this.flash.position.copy(this.muzzle.position);
      }

      this.audio.play(this.suppressorEnabled ? 'dry' : 'dry'); // Provide some feedback, adjust if you have a specific sound
    }
  }

  toggleAltView() {
    this.altViewEnabled = !this.altViewEnabled;
    this.targetBasePosition.copy(this.altViewEnabled ? this.altBasePosition : this.defaultBasePosition);
    this.targetBaseRotation.copy(this.altViewEnabled ? this.altBaseRotation : this.defaultBaseRotation);
  }

  /**
   * The magnification the scope is currently set to, or 0 for a weapon that has
   * no scope at all. The HUD reads this to show what the player is looking
   * through.
   */
  getScopeMagnification() {
    return this.config.scope?.magnifications[this.scopeStep] ?? 0;
  }

  /**
   * The field of view this weapon shows at full ADS, or null when it has no
   * scope and should fall back to the shared `ads.fov`. A magnification of M
   * shows baseFov / M, clamped so the scope never becomes a pinhole.
   */
  getAdsFov() {
    const scope = this.config.scope;
    if (!scope) return null;
    const magnification = scope.magnifications[this.scopeStep] ?? scope.magnifications[0];
    return Math.max(scope.minFov, GAME_CONFIG.player.baseFov / magnification);
  }

  /**
   * Steps the scope one notch. `direction` is +1 to magnify and -1 to widen.
   * Returns true when the setting actually changed, so the caller can skip
   * work (and the HUD can ignore) a scroll that was already at the end stop.
   */
  zoomScope(direction) {
    const scope = this.config.scope;
    if (!scope) return false;
    const next = THREE.MathUtils.clamp(this.scopeStep + direction, 0, scope.magnifications.length - 1);
    if (next === this.scopeStep) return false;
    this.scopeStep = next;
    return true;
  }

  tryFire() {
    if (this.fireCooldown > 0 || this.dryCooldown > 0) return;
    if (this.reloading) {
      // Mag-fed weapons have to finish the reload, but a shotgun can be broken
      // out of a shell reload: whatever is already seated stays in the tube and
      // the shells that had not gone in yet are simply left in reserve.
      if (!this.isShotgun) return;
      this.cancelShellReload();
    }
    if (this.magazine <= 0) {
      this.dryCooldown = 0.28;
      this.audio.play('dry');
      this.callbacks.onDry?.();
      return;
    }

    const shot = this.createShotSolution();
    if (!shot) {
      this.shotDiagnostics.failed += 1;
      return;
    }

    let fired = null;
    try {
      fired = this.isShotgun ? this.firePellets(shot) : this.fireProjectile(shot);
    } catch (error) {
      console.warn('[WeaponSystem] Projectile creation failed.', error);
    }
    const shotCount = Array.isArray(fired) ? fired.length : (fired ? 1 : 0);
    if (!shotCount) {
      this.shotDiagnostics.failed += 1;
      return;
    }

    this.callbacks.onFired?.(shot.origin, shot.direction);

    this.magazine -= 1;
    this.fireCooldown = this.config.fireInterval;
    this.flashTimer = 0.045;
    this.weaponKick = Math.min(0.8, this.weaponKick + (this.displayName === 'Pistol' ? 0.55 : 0.45));
    this.shotCounter += 1;
    // Random directional recoil: pulls up-left, up-right, or straight up randomly
    const directionRoll = Math.random();
    let yawBias = 0;
    if (directionRoll < 0.35) yawBias = -1;       // pull up-left
    else if (directionRoll < 0.7) yawBias = 1;     // pull up-right
    else yawBias = (Math.random() - 0.5) * 0.5;    // mostly straight up

    const progressivePitch = this.config.recoilPitch * (0.7 + Math.random() * 0.6)
      * (1 + Math.min(this.shotCounter, 15) * 0.05);
    const recoilYaw = this.config.recoilYaw * yawBias * (0.6 + Math.random() * 0.8)
      * (1 + Math.min(this.shotCounter, 10) * 0.06)
      + (Math.random() - 0.5) * this.config.recoilYaw * 0.4;
    this.player.addRecoil(progressivePitch, recoilYaw);
    this.player.addShake(0.08 + this.shotCounter * 0.008);
    if (this.isShotgun) {
      // One blast = one sound, no matter how many pellets it threw.
      this.audio.play('shotgun_shot');
    } else if (this.displayName === 'M416' || this.displayName === 'SCAR') {
      this.audio.play(this.suppressorEnabled ? 'suppressed_shot' : 'm4_shot');
    } else if (this.displayName === 'Pistol') {
      this.audio.play('glock_shot');
    } else {
      this.audio.play('gunshot');
    }
    this.emitAmmo();

    this.shotDiagnostics.created += shotCount;
    this.shotDiagnostics.lastOrigin = shot.origin.toArray();
    this.shotDiagnostics.lastTarget = shot.target.toArray();
    this.shotDiagnostics.lastDirection = shot.direction.toArray();
    this.shotDiagnostics.lastAds = shot.ads;

    if (this.weaponRig) {
      this.weaponRig.fire(() => {
        if (!this.ejectShell()) {
          console.warn('[WeaponSystem] Shot fired, but ShellEjectPoint was unavailable.');
        }
      });
    } else if (!this.ejectShell()) {
      console.warn('[WeaponSystem] Shot fired, but the shell ejection point was unavailable.');
    }
  }

  createShotSolution() {
    this.camera.updateWorldMatrix(true, true);
    this.model.updateWorldMatrix(true, true);

    const origin = new THREE.Vector3();
    if (!this.getMuzzleSpawnPosition(origin)) {
      console.warn('[WeaponSystem] MuzzlePoint is unavailable; the shot was not created.');
      return null;
    }

    const aim = this.calculateAimTarget();
    if (!aim) {
      console.warn('[WeaponSystem] Aiming target calculation failed; the shot was not created.');
      return null;
    }

    const direction = aim.target.clone().sub(origin);
    if (direction.lengthSq() < 0.000001) direction.copy(aim.direction);
    direction.normalize();
    return { origin, target: aim.target, direction, ads: aim.ads };
  }

  getMuzzleSpawnPosition(target) {
    if (this.suppressorEnabled && this.suppressorPoint) {
      this.suppressorPoint.getWorldPosition(target);
      return true;
    }
    if (this.weaponRig?.getMuzzlePosition(target)) return true;
    if (this.modelAsset) return false;
    return target.copy(this.muzzle.getWorldPosition(new THREE.Vector3()));
  }

  calculateAimTarget() {
    this.camera.updateWorldMatrix(true, true);
    const cameraOrigin = this.camera.getWorldPosition(new THREE.Vector3());
    const cameraDirection = this.camera.getWorldDirection(new THREE.Vector3());
    const cameraTarget = this.raycastAimTarget(cameraOrigin, cameraDirection);
    if (!cameraTarget) return null;

    const ads = this.adsAmount > 0.5;
    const sight = this.weaponRig?.getAimReference() ?? null;
    if (!ads) return { target: cameraTarget, direction: cameraDirection, ads };

    if (!sight) {
      console.warn('[WeaponSystem] ADS is active, but AimPoint/RedDot is unavailable; using camera center.');
      return { target: cameraTarget, direction: cameraDirection, ads };
    }

    const sightPosition = sight.getWorldPosition(new THREE.Vector3());
    const sightDirection = cameraTarget.clone().sub(sightPosition);
    if (sightDirection.lengthSq() < 0.000001) sightDirection.copy(cameraDirection);
    sightDirection.normalize();
    const target = this.raycastAimTarget(sightPosition, sightDirection) ?? sightPosition.clone().addScaledVector(sightDirection, this.config.range);
    return { target, direction: sightDirection, ads };
  }

  raycastAimTarget(origin, direction) {
    const fallback = origin.clone().addScaledVector(direction, this.config.range);
    try {
      // World geometry first (solid from both sides), then dynamic targets.
      const worldHit = this.arena.traceShot(origin, direction, this.config.range);
      let best = worldHit ? { point: worldHit.point, distance: worldHit.distance } : null;
      const targets = this.getCollisionTargets();
      if (targets.length) {
        this.aimRaycaster.firstHitOnly = true;
        this.aimRaycaster.set(origin, direction);
        this.aimRaycaster.far = best ? best.distance : this.config.range;
        const dynamicHit = this.aimRaycaster.intersectObjects(targets, false)
          .find((intersection) => this.isValidProjectileHit(intersection));
        if (dynamicHit && (!best || dynamicHit.distance < best.distance)) best = dynamicHit;
      }
      return best?.point?.clone() ?? fallback;
    } catch (error) {
      console.warn('[WeaponSystem] Aiming raycast failed.', error);
      return null;
    }
  }

  fireProjectile(shot) {
    const projectileConfig = this.config.mechanics.projectile;
    return this.projectiles.fire({
      origin: shot.origin,
      direction: shot.direction,
      speed: projectileConfig.speed,
      range: projectileConfig.range,
      spread: this.spread,
      length: projectileConfig.length,
    });
  }

  /**
   * One trigger pull, a whole fan of pellets. They all leave the gun's own
   * bullet-spawn point (`shot.origin`, i.e. the muzzle) and none of them share
   * a direction: the cone is sampled as an even golden-angle spiral that is
   * rotated and jittered per shot, which reads as a natural pattern instead
   * of random noise. Each pellet carries its own slice of the weapon damage.
   */
  firePellets(shot) {
    const pellets = this.pelletConfig;
    const projectileConfig = this.config.mechanics.projectile;
    const count = Math.max(1, Math.round(pellets.count));
    const bodyPerPellet = this.config.bodyDamage / count;
    const headPerPellet = this.config.headDamage / count;

    // A stable perpendicular basis around the aim direction: the pellets fan
    // out sideways/upwards from where the player is actually looking.
    const forward = shot.direction.clone().normalize();
    const worldUp = Math.abs(forward.y) > 0.98 ? new THREE.Vector3(0, 0, 1) : new THREE.Vector3(0, 1, 0);
    const right = new THREE.Vector3().crossVectors(forward, worldUp).normalize();
    const up = new THREE.Vector3().crossVectors(right, forward).normalize();

    const spin = Math.random() * Math.PI * 2;
    const fired = [];
    for (let index = 0; index < count; index += 1) {
      const angle = spin + index * GOLDEN_ANGLE;
      const radius = pellets.spread * Math.sqrt((index + 0.5) / count) * (0.85 + Math.random() * 0.3);
      const direction = forward.clone()
        .addScaledVector(right, Math.cos(angle) * radius)
        .addScaledVector(up, Math.sin(angle) * radius)
        .normalize();
      const pellet = this.projectiles.fire({
        origin: shot.origin,
        direction,
        speed: projectileConfig.speed,
        range: projectileConfig.range,
        // The cone is already baked into the direction above.
        spread: 0,
        length: projectileConfig.length,
        style: projectileConfig.style,
        damage: bodyPerPellet,
        headDamage: headPerPellet,
        originRef: shot.origin,
      });
      if (pellet) fired.push(pellet);
    }
    return fired;
  }

  getCollisionTargets() {
    // Static geometry is traced through the arena's collision world; only the
    // moving actors still need a mesh raycast.
    return this.callbacks.getBotHitMeshes?.() ?? [];
  }

  isValidProjectileHit(intersection) {
    const object = intersection?.object;
    if (!object) return false;
    if (this.model.getObjectById(object.id)) return false;
    const bot = object.userData.bot;
    return !bot || !bot.dead;
  }

  ejectShell() {
    if (!this.weaponRig) return false;
    const position = new THREE.Vector3();
    if (!this.weaponRig.getShellTransform(position)) return false;

    const right = new THREE.Vector3();
    const up = new THREE.Vector3();
    const backward = new THREE.Vector3();
    if (!this.weaponRig.getGunBasis(right, up, backward)) return false;
    this.shells.eject({ position, right, up, backward });
    return true;
  }

  handleProjectileImpact(intersection, direction, projectile = null) {
    this.shotDiagnostics.impacts += 1;
    const object = intersection.object ?? null;
    const faceNormal = intersection.face?.normal;
    const normal = intersection.normal
      ? intersection.normal.clone()
      : (faceNormal && object
        ? faceNormal.clone().transformDirection(object.matrixWorld).normalize()
        : direction.clone().negate());
    const bot = object?.userData?.bot;
    const isPlayer = object?.userData?.isPlayer;
    // Each projectile pays out on its own terms, so a pellet hit is a fraction
    // of the blast and several pellets simply add up.
    const damage = this.resolveProjectileDamage(projectile, intersection.point);
    
    if (bot && !bot.dead) {
      this.shotDiagnostics.botHits += 1;
      const headshot = Boolean(object.userData.head);
      this.effects.hit(intersection.point, headshot);
      this.callbacks.onBotHit?.(bot, headshot ? damage.head : damage.body, intersection.point, headshot);
    } else if (isPlayer) {
      // Remote players are the duel character, so the head is tagged on the mesh
      // itself. The height band is only a fallback for anything that arrives
      // untagged - a height test against a part's own local position is wrong
      // now that a body is six boxes rather than one cylinder.
      const headshot = object.userData.head !== undefined
        ? Boolean(object.userData.head)
        : intersection.point.y > object.position.y + 0.6;
      this.effects.hit(intersection.point, headshot);
      this.callbacks.onPlayerHit?.(
        object.userData.id,
        headshot ? damage.head : damage.body,
        headshot
      );
    } else {
      this.effects.impact(intersection.point, normal, 'dust');
    }
  }

  /**
   * How much damage this particular projectile deals at this point. Plain
   * bullets use the weapon's full figure; a pellet uses its own share, scaled
   * down with distance so a blast that only connects at range cannot carry
   * the same punch as one at contact range.
   */
  resolveProjectileDamage(projectile, point) {
    const full = { body: this.config.bodyDamage, head: this.config.headDamage };
    if (!projectile || typeof projectile.damage !== 'number') return full;

    const pellets = this.pelletConfig;
    let multiplier = 1;
    if (pellets) {
      const travelled = point && projectile.originRef
        ? point.distanceTo(projectile.originRef)
        : 0;
      const start = pellets.damageFalloffStart;
      const end = Math.max(start + 0.001, pellets.damageFalloffEnd);
      if (travelled <= start) {
        multiplier = 1;
      } else if (travelled >= end) {
        multiplier = pellets.damageFalloffMin;
      } else {
        const phase = (travelled - start) / (end - start);
        multiplier = 1 + (pellets.damageFalloffMin - 1) * phase;
      }
    }
    return {
      body: projectile.damage * multiplier,
      head: (projectile.headDamage ?? projectile.damage) * multiplier,
    };
  }

  startReload() {
    if (this.reloading || this.magazine >= this.config.magazineSize || this.reserve <= 0) return;
    this.reloading = true;
    this.reloadElapsed = 0;
    if (this.isShotgun) {
      // Only the shells that are actually missing get loaded, so a partly
      // loaded tube finishes quickly instead of replaying all five.
      this.shellReload.needed = Math.min(this.config.magazineSize - this.magazine, this.reserve);
      this.shellReload.inserted = 0;
      this.shellReload.loaded = -1;
    } else {
      this.weaponRig?.beginReload();
    }
    if (this.displayName === 'Pistol' && !this.isShotgun) {
      this.audio.play('reload_pistol');
    } else if (!this.isShotgun) {
      // The shotgun skips this: its per-shell clicks carry the rhythm, and a
      // magazine-swap click on top of them would only muddy it.
      this.audio.play('reload_m4');
    }
    this.callbacks.onReloadStart?.();
    this.emitAmmo();
  }

  /**
   * How long this reload will take. A rifle swaps its magazine in one fixed
   * beat; a shotgun loads one shell per beat and only for as many as are
   * actually missing.
   */
  getReloadDuration() {
    if (!this.isShotgun) return this.config.reloadDuration;
    const shells = this.shellReload.needed || Math.max(0, this.config.magazineSize - this.magazine);
    return Math.max(0.05, shells * this.getShellLoadInterval());
  }

  getShellLoadInterval() {
    return this.shellReloadSettings?.shellDuration ?? 0.15;
  }

  updateReload(delta) {
    if (!this.reloading) return;
    this.reloadElapsed += delta;

    if (this.isShotgun) {
      this.updateShellReload();
      return;
    }

    this.weaponRig?.updateReload(this.reloadElapsed / this.config.reloadDuration);
    this.callbacks.onReloadProgress?.(this.magazine, this.reserve, this.reloadElapsed);
    if (this.reloadElapsed >= this.config.reloadDuration) {
      const needed = this.config.magazineSize - this.magazine;
      const loaded = Math.min(needed, this.reserve);
      this.magazine += loaded;
      this.reserve -= loaded;
      this.weaponRig?.finishReload();
      this.reloading = false;
      this.reloadElapsed = 0;
      this.callbacks.onReloadEnd?.();
      this.emitAmmo();
    }
  }

  /**
   * The tubular reload: the tube fills one shell per short beat, and the ammo
   * count rises by one for each shell that goes in. This deliberately does not
   * depend on the weapon model or on any animation, so a model that is missing
   * an attachment point can never leave the reload stuck.
   *
   * A round is granted at SHELL_LOAD_BEAT.insert, the point in the beat where the
   * hand has pushed it down the tube, rather than on the beat boundary. The
   * totals are identical either way - this only moves the tick from the start of
   * a beat to the moment the round is actually in the gun, so the HUD does not
   * claim a shell the animation has not loaded yet.
   */
  updateShellReload() {
    const state = this.shellReload;
    const interval = this.getShellLoadInterval();
    // Where the reload is, measured in beats rather than seconds, so the ammo
    // grant and the hand animation are driven off the same clock and cannot
    // drift apart by a frame.
    const beats = this.reloadElapsed / interval;
    // A round is granted the moment the hand pushes it down the tube, not on the
    // beat boundary - otherwise the HUD ticks a shell up while the hand is still
    // on its way to the port. Totals are unchanged, only the tick moves.
    const grantable = Math.min(
      state.needed,
      Math.max(0, Math.floor(beats - SHELL_LOAD_BEAT.insert) + 1),
    );

    while (state.inserted < grantable) {
      state.inserted += 1;
      this.magazine = Math.min(this.config.magazineSize, this.magazine + 1);
      this.reserve = Math.max(0, this.reserve - 1);
      this.audio.play('shell_insert');
    }
    if (state.inserted !== state.loaded) {
      state.loaded = state.inserted;
      this.emitAmmo();
    }

    this.callbacks.onReloadProgress?.(this.magazine, this.reserve, this.reloadElapsed);

    // Done once the last round is in AND its follow-through has played, so the
    // hand is not cut off mid-push. `getReloadDuration` is exactly `needed`
    // beats, so this is also the frame the progress bar reaches full.
    if (beats >= state.needed) this.finishShellReload();
  }

  /**
   * Drives the support hand and the viewmodel's loading pose. Runs every frame
   * the gun exists, not only while reloading, because the hand still has to walk
   * back to the grip after the last round - the reload is over, the hand is not.
   *
   * `beat` is -1 when there is nothing to load, which is what puts the hand into
   * its return rather than leaving it wherever the last beat ended.
   */
  updateShellLoadAnimation(delta) {
    if (!this.hands) return;

    // The port comes from the model's own `shell insert point`, resolved once by
    // the rig. A model without one still reloads - the hand just stays on the
    // grip and the ammo still counts up.
    const hasPort = Boolean(this.weaponRig?.getShellInsertTransform(
      this.shellPortPoint,
      this.shellPortDir,
    ));

    let beat = -1;
    let phase = 0;
    if (this.reloading && this.isShotgun) {
      const interval = this.getShellLoadInterval();
      const position = this.reloadElapsed / interval;
      const whole = Math.floor(position);
      beat = Math.min(this.shellReload.needed - 1, whole);
      phase = position - whole;
    }

    // Only hand the port to the hand when the hand can actually be seen working
    // it. Held in its normal carry the tube mouth is off the bottom of the
    // screen and the point the fist has to stand at is behind the near plane, so
    // without this the hand would dive out of frame and vanish mid-reload -
    // worse than it never leaving the grip. The gun still cants over, and the
    // ammo still counts up either way.
    this.hands.updateShellLoad({
      beat: this.shellPortVisible() ? beat : -1,
      phase,
      delta,
      insertPoint: hasPort ? this.shellPortPoint : null,
      insertDir: hasPort ? this.shellPortDir : null,
    });
  }

  /**
   * Whether the loading port is somewhere the player can see it.
   *
   * Projected through the camera rather than assumed, because it depends on the
   * live holder transform - aim, sprint and the reload cant all move it. The
   * hand is given a generous margin: it is a big object, and it only has to be
   * close enough to read as working the tube.
   */
  shellPortVisible() {
    if (this.shellPortProjected) {
      const { x, y, z } = this.shellPortProjected;
      return z > -1 && z < 1 && Math.abs(x) < 1.2 && Math.abs(y) < 1.2;
    }
    return false;
  }

  finishShellReload() {
    this.reloading = false;
    this.reloadElapsed = 0;
    this.shellReload.inserted = 0;
    this.shellReload.loaded = -1;
    this.callbacks.onReloadEnd?.();
    this.emitAmmo();
  }

  /** Firing out of a reload keeps whatever is already seated. */
  cancelShellReload() {
    this.reloading = false;
    this.reloadElapsed = 0;
    this.shellReload.inserted = 0;
    this.shellReload.loaded = -1;
    this.callbacks.onReloadEnd?.();
    this.emitAmmo();
  }

  emitAmmo() {
    this.callbacks.onAmmoChange?.(
      this.magazine,
      this.reserve,
      this.reloading,
      this.reloadElapsed,
      this.getReloadDuration(),
    );
  }
}

// Golden angle, so the pellets spread evenly across the cone instead of
// bunching up like a random spray would.
const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
