import * as THREE from 'three';

const LOCAL_FORWARD = new THREE.Vector3(0, 0, 1);
const WORLD_DOWN = new THREE.Vector3(0, -1, 0);

const REFERENCE_DEFINITIONS = Object.freeze([
  { key: 'gunBody', expected: 'GunBody', candidates: ['GunBody'] },
  // `bulletspawnpoint` is how the shotgun model names its fire point; binding
  // it here means every existing consumer (muzzle, aim, flash, ejection
  // basis) reuses the model's own point instead of inventing another one.
  { key: 'muzzlePoint', expected: 'MuzzlePoint', candidates: ['MuzzlePoint', 'muzzlepoint', 'Muzzlepoint', 'Muzzleoint', 'bulletspawnpoint', 'BulletSpawnPoint', 'bullet spawn point', 'FirePoint'] },
  { key: 'shellEjectPoint', expected: 'ShellEjectPoint', candidates: ['ShellEjectPoint', 'Shellejectionpoint', 'shellejectionpoint', 'ShellEjectionPoint', 'shell ejection point'] },
  // The tube's loading port. Note the underscore forms: GLTFLoader runs every
  // node name through PropertyBinding.sanitizeNodeName, so a model authored as
  // "shell insert point" reaches us as "shell_insert_point".
  { key: 'shellInsertPoint', expected: 'ShellInsertPoint', candidates: ['ShellInsertPoint', 'shell_insert_point', 'shellinsertpoint', 'ShellInsertionPoint', 'shell_insertion_point', 'shell_load_point', 'shell insert point', 'shellinsertpoint', 'ShellInsertionPoint', 'shell insertion point', 'shellloadpoint', 'ShellLoadPoint'] },
  { key: 'bolt', expected: 'Bolt', candidates: ['Bolt', 'bolt', 'Cock', 'cock', 'slide', 'Slide', 'uar15 bolt'] },
  { key: 'chargingHandle', expected: 'ChargingHandle', candidates: ['Charging_Handle', 'Charginghandle', 'charginghandle', 'charging_handle', 'charging handle'] },
  { key: 'trigger', expected: 'Trigger', candidates: ['Trigger', 'trigger', 'm1014_trigga', 'm1014 trigga', 'Trigga'] },
  {
    key: 'magazine',
    expected: 'Magazine',
    candidates: ['Magazine', '54539_ak12_30rnd_empty_mag_15', 'magazine', 'Magazine_30_Round_PMAG', 'Magazines'],
  },
  { key: 'scope', expected: 'Scope', candidates: ['Scope', 'Scope_mount', 'ddmk18_iron_sight_18'] },
  { key: 'scopeGlass', expected: 'ScopeGlass', candidates: ['ScopeGlass', 'scope_gglass'] },
  { key: 'redDot', expected: 'RedDot', candidates: ['RedDot', 'red_dot'] },
  { key: 'adsAim', expected: 'ADSAim', candidates: ['ADSAim', 'adsaimpoint'] },
  { key: 'aimPoint', expected: 'AimPoint', candidates: ['AimPoint', 'aimpoint'] },
  { key: 'bulletTemplate', expected: 'Bullet', candidates: ['Bullet', 'BulletTemplate'] },
  { key: 'shellTemplate', expected: 'Shell', candidates: ['Shell', 'ShellTemplate', 'Bulletshell', 'BulletShell', 'Object_11'] },
  /**
   * The shell that is actually loaded in the gun. Unlike `shellTemplate` this
   * one stays visible in the model (on the shotgun it is the round sitting in
   * the tube), so it is reused for the eject and the reload-insert animation
   * instead of being hidden away.
   */
  { key: 'shellModel', expected: 'Shell', candidates: ['Shell', 'ShellTemplate', 'Bulletshell', 'BulletShell', 'Object_11', 'bulletcell', 'shellcell', 'Shells'] },
]);

export class GLBWeaponRig {
  constructor({ model, asset, mechanics, boltTravelOverride = null }) {
    this.model = model;
    this.asset = asset;
    this.config = mechanics;
    this.boltTravelOverride = boltTravelOverride;
    this.references = {};
    this.referenceAudit = null;
    this.adsLocalPosition = null;
    this.adsReferenceName = null;
    this.templateWorldScales = new Map();
    this.muzzleDirection = new THREE.Vector3(0, 0, -1);
    this.muzzleDirectionLocal = new THREE.Vector3(0, 0, -1);
    this.muzzleDirectionValid = false;
    this.muzzleDirectionCorrected = false;

    this.boltElapsed = Infinity;
    this.triggerElapsed = Infinity;
    this.pendingShellEject = null;
    this.boltShellEjected = true;
    this.boltBasePosition = null;
    this.boltTravelDirection = new THREE.Vector3();
    this.boltLocalTravel = 0;
    this.triggerBasePosition = null;
    this.triggerTravelDirection = new THREE.Vector3();
    this.triggerLocalTravel = 0;
    this.chargingHandleBasePosition = null;

    this.currentMagazine = null;
    this.baseMagazine = null;
    this.magazineTemplate = null;
    this.magazineParent = null;
    this.magazineBasePosition = new THREE.Vector3();
    this.magazineBaseQuaternion = new THREE.Quaternion();
    this.magazineBaseScale = new THREE.Vector3(1, 1, 1);
    this.magazineOutPosition = new THREE.Vector3();
    this.magazineOutQuaternion = new THREE.Quaternion();
    this.magazineReplacement = null;
    this.reloadAnimationActive = false;
    this.reloadMagazineSwapped = false;
    this.reloadBoltActive = false;

    this.bindReferences();
  }

  bindReferences() {
    const missingExpected = [];
    const substitutions = {};
    const unresolved = [];

    for (const definition of REFERENCE_DEFINITIONS) {
      const { object: resolvedObject, by: resolvedBy } = this.resolveReference(definition);

      this.references[definition.key] = resolvedObject ?? null;
      if (resolvedBy !== definition.expected) missingExpected.push(definition.expected);
      if (!resolvedObject) {
        unresolved.push(definition.expected);
      } else if (resolvedBy !== definition.expected) {
        substitutions[definition.expected] = resolvedBy;
      }
    }

    this.referenceAudit = {
      missingExpected,
      substitutions,
      unresolved,
      aimFallback: this.references.aimPoint
        ? 'AimPoint'
        : this.references.adsAim
          ? 'ADSAim'
          : this.references.redDot
            ? 'RedDot'
            : null,
    };

    console.info('GLB weapon reference audit:', this.referenceAudit);
    if (missingExpected.length || unresolved.length) {
      console.warn('Some expected GLB weapon names were unavailable.', this.referenceAudit);
    }

    this.configureHiddenTemplates();
    if (this.references.redDot) {
      this.references.redDot.visible = false;
      this.configureRedDotMaterial(this.references.redDot);
    }
    this.configureMuzzleDirection();
    this.configureBoltAndTrigger();
    this.configureMagazine();
    this.configureAdsReference();
    this.attachSightsToBolt();
    this.tweakMaterials();
  }

  /**
   * Resolves one reference by name. The expected name is tried first, then the
   * known aliases, and finally a separator/case-insensitive comparison. That
   * last step matters because GLTFLoader rewrites node names through
   * PropertyBinding.sanitizeNodeName ("shell insert point" becomes
   * "shell_insert_point"), so a model can ship a perfectly good attachment
   * point under a name none of the aliases spelled out.
   */
  resolveReference(definition) {
    const expected = this.asset.getObjectByName(definition.expected);
    if (expected) return { object: expected, by: definition.expected };

    for (const candidate of definition.candidates) {
      const found = this.asset.getObjectByName(candidate);
      if (found) return { object: found, by: candidate };
    }

    const wanted = normalizeNodeName(definition.expected);
    let fallback = null;
    this.asset.traverse((child) => {
      if (fallback || !child.name) return;
      if (normalizeNodeName(child.name) === wanted) fallback = child;
    });
    return fallback ? { object: fallback, by: fallback.name } : { object: null, by: null };
  }

  attachSightsToBolt() {
    const { bolt, aimPoint, adsAim, redDot, scope, scopeGlass } = this.references;
    
    // Only attach sights to the moving part if it's a pistol slide. 
    // On rifles, the bolt moves independently of the upper receiver and scope.
    if (!bolt || !bolt.name.toLowerCase().includes('slide')) return;

    const sights = [aimPoint, adsAim, redDot, scope, scopeGlass].filter(Boolean);
    
    // Ensure all visual scope meshes are also grabbed
    this.model.traverse((child) => {
      const name = child.name?.toLowerCase() || '';
      if (name.includes('holosight') || name.includes('reddot') || name.includes('scope')) {
        if (!sights.includes(child)) sights.push(child);
      }
    });

    for (const sight of sights) {
      if (sight.parent !== bolt) {
        // preserve world position while re-parenting
        sight.updateWorldMatrix(true, false);
        bolt.updateWorldMatrix(true, false);
        bolt.attach(sight);
      }
    }
  }

  tweakMaterials() {
    // Intentionally left blank to use the default roughness and metalness 
    // of the GLB model as requested by the user.
  }

  configureHiddenTemplates() {
    for (const template of [this.references.bulletTemplate, this.references.shellTemplate]) {
      if (!template) continue;
      template.updateWorldMatrix(true, false);
      this.templateWorldScales.set(template, template.getWorldScale(new THREE.Vector3()));
      template.visible = false;
      template.traverse((child) => {
        child.frustumCulled = false;
        if (child.isMesh) {
          child.castShadow = false;
          child.receiveShadow = false;
        }
      });
    }

    // The loaded shell stays in the model, so it is never hidden - it only
    // needs its world scale recorded so the ejected/inserted copies of it come
    // out the same size the one sitting in the gun is.
    const shellModel = this.references.shellModel;
    if (shellModel && !this.templateWorldScales.has(shellModel)) {
      shellModel.updateWorldMatrix(true, false);
      this.templateWorldScales.set(shellModel, shellModel.getWorldScale(new THREE.Vector3()));
    }
  }

  configureRedDotMaterial(redDot) {
    const material = redDot.material;
    if (!material || Array.isArray(material)) return;
    const dotMaterial = material.clone();
    dotMaterial.color?.setHex(0xff0000); // Pure red
    if ('emissive' in dotMaterial) {
      dotMaterial.emissive.setHex(0xff0000); // Pure bright red glow
      dotMaterial.emissiveIntensity = 4.0; // High intensity for bloom/brightness
    }
    dotMaterial.toneMapped = false;
    redDot.material = dotMaterial;
  }

  getTemplateWorldScale(template) {
    return this.templateWorldScales.get(template)?.clone() ?? null;
  }

  configureMuzzleDirection() {
    const point = this.references.muzzlePoint;
    if (!point) return;

    this.model.updateWorldMatrix(true, true);
    const muzzleReference = this.findNamedObject(['Muzzle', 'ddmk18_flash_hider_14', 'm1014_18.5in_barrel', 'm1014_18_5in_barrel', 'm1014 barrel']);
    const barrelPoint = this.findNamedObject(['ak200_barrel_8', 'ddmk18_103in_barrel_9']);
    const receiver = this.findNamedObject(['ak200_receiver_6', 'ddmk18_upper_0', 'm1014_receiver', 'm1014 receiver']);
    
    // We will compute the default direction from the point itself.
    let outward = null;
    
    if (muzzleReference && (barrelPoint || receiver)) {
      const muzzleCenter = this.referenceCenter(muzzleReference);
      const barrelOrigin = barrelPoint
        ? barrelPoint.getWorldPosition(new THREE.Vector3())
        : this.referenceCenter(receiver);
      outward = muzzleCenter.sub(barrelOrigin).normalize();
      if (outward.lengthSq() < 0.000001) outward = null;
    }
    
    if (!outward) {
      // Fallback to the model's local forward direction (-Z) in world space
      outward = new THREE.Vector3(0, 0, -1).transformDirection(this.model.matrixWorld).normalize();
      console.warn('MuzzlePoint direction was corrected using the model\'s default forward axis.');
    }

    const existingDirection = point.getWorldDirection(new THREE.Vector3());
    this.muzzleDirectionCorrected = existingDirection.dot(outward) < 0.985;

    if (this.muzzleDirectionCorrected) {
      const parentWorldQuaternion = point.parent.getWorldQuaternion(new THREE.Quaternion()).invert();
      const desiredWorldQuaternion = new THREE.Quaternion().setFromUnitVectors(LOCAL_FORWARD, outward);
      point.quaternion.copy(parentWorldQuaternion.multiply(desiredWorldQuaternion));
      point.updateWorldMatrix(true, false);
    }

    this.muzzleDirection = new THREE.Vector3();
    this.muzzleDirectionLocal = new THREE.Vector3();
    this.muzzleDirection.copy(point.getWorldDirection(new THREE.Vector3()));
    
    const inverseModelRotation = this.model.getWorldQuaternion(new THREE.Quaternion()).invert();
    this.muzzleDirectionLocal.copy(this.muzzleDirection).applyQuaternion(inverseModelRotation).normalize();
    
    this.muzzleDirectionValid = true;
  }

  findNamedObject(names) {
    for (const name of names) {
      const object = this.asset.getObjectByName(name);
      if (object) return object;
    }
    return null;
  }

  referenceCenter(object) {
    if (object?.isMesh) {
      const bounds = new THREE.Box3().setFromObject(object);
      if (!bounds.isEmpty()) return bounds.getCenter(new THREE.Vector3());
    }
    return object.getWorldPosition(new THREE.Vector3());
  }

  configureBoltAndTrigger() {
    const { bolt, trigger } = this.references;
    if (bolt) {
      this.boltBasePosition = bolt.position.clone();
      const backwardInWorld = this.muzzleDirection.clone().negate();
      const backwardInParent = worldDirectionToParent(backwardInWorld, bolt.parent);
      this.boltTravelDirection.copy(backwardInParent).normalize();
      const scale = bolt.parent.getWorldScale(new THREE.Vector3()).x || 1;
      this.boltLocalTravel = (this.boltTravelOverride !== undefined && this.boltTravelOverride !== null ? this.boltTravelOverride : this.config.bolt.travel) / scale;
    }

    const { chargingHandle } = this.references;
    if (chargingHandle) {
      this.chargingHandleBasePosition = chargingHandle.position.clone();
      const backwardInWorld = this.muzzleDirection.clone().negate();
      const backwardInParent = worldDirectionToParent(backwardInWorld, chargingHandle.parent);
      this.chargingHandleTravelDirection = backwardInParent.normalize();
      const scale = chargingHandle.parent.getWorldScale(new THREE.Vector3()).x || 1;
      this.chargingHandleLocalTravel = (this.boltTravelOverride !== undefined && this.boltTravelOverride !== null ? this.boltTravelOverride : this.config.bolt.travel) / scale;
    }

    if (trigger) {
      this.triggerBasePosition = trigger.position.clone();
      this.triggerTravelDirection.copy(
        worldDirectionToParent(this.muzzleDirection.clone().negate(), trigger.parent),
      ).normalize();
      const scale = trigger.parent.getWorldScale(new THREE.Vector3()).x || 1;
      this.triggerLocalTravel = this.config.trigger.travel / scale;
    }
  }

  configureMagazine() {
    const magazine = this.references.magazine;
    if (!magazine?.parent) return;

    this.currentMagazine = magazine;
    this.baseMagazine = magazine;
    this.magazineTemplate = magazine.clone(true);
    this.magazineParent = magazine.parent;
    this.magazineBasePosition.copy(magazine.position);
    this.magazineBaseQuaternion.copy(magazine.quaternion);
    this.magazineBaseScale.copy(magazine.scale);

    const downInParent = worldDirectionToParent(WORLD_DOWN, this.magazineParent);
    const forwardInParent = worldDirectionToParent(this.muzzleDirection.clone(), this.magazineParent);
    const scale = this.magazineParent.getWorldScale(new THREE.Vector3()).x || 1;
    this.magazineOutPosition.copy(this.magazineBasePosition)
      .addScaledVector(downInParent, this.config.magazine.downDistance / scale)
      .addScaledVector(forwardInParent, this.config.magazine.backwardDistance / scale);

    const removalTilt = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.16, 0.04, -0.2));
    this.magazineOutQuaternion.copy(this.magazineBaseQuaternion).multiply(removalTilt);
  }

  configureAdsReference() {
    const reference = this.references.aimPoint ?? this.references.adsAim ?? this.references.redDot;
    if (!reference) return;

    this.model.updateWorldMatrix(true, true);
    const positionInModel = reference.getWorldPosition(new THREE.Vector3());
    this.model.worldToLocal(positionInModel);
    this.adsLocalPosition = positionInModel;
    this.adsReferenceName = reference.name;
  }

  fire(onBoltRear = null) {
    this.boltElapsed = 0;
    this.triggerElapsed = 0;
    this.pendingShellEject = onBoltRear;
    this.boltShellEjected = false;
  }

  update(delta) {
    // The eject timer owns the shot clock. It advances for every weapon,
    // including models with no cycling bolt (the shotgun has no Bolt node, so
    // `updateBolt` never runs and used to swallow the eject callback).
    if (this.boltElapsed < this.config.bolt.duration) this.boltElapsed += delta;
    this.updateShellEjectTiming();
    this.updateBolt();
    this.updateTrigger(delta);
  }

  updateShellEjectTiming() {
    if (this.boltShellEjected) return;
    if (this.boltElapsed < this.config.bolt.duration * 0.38) return;
    this.boltShellEjected = true;
    this.pendingShellEject?.();
    this.pendingShellEject = null;
  }

  updateBolt() {
    const bolt = this.references.bolt;
    if (!bolt || !this.boltBasePosition || this.boltElapsed >= this.config.bolt.duration) return;

    const progress = THREE.MathUtils.clamp(this.boltElapsed / this.config.bolt.duration, 0, 1);
    let amount = 0;
    if (progress < 0.38) {
      const phase = progress / 0.38;
      amount = 1 - ((1 - phase) ** 3);
    } else if (progress < 0.54) {
      amount = 1;
    } else {
      const phase = (progress - 0.54) / 0.46;
      amount = 1 - smoothstep(phase);
    }

    bolt.position.copy(this.boltBasePosition)
      .addScaledVector(this.boltTravelDirection, this.boltLocalTravel * amount);
    if (progress >= 1) bolt.position.copy(this.boltBasePosition);
  }

  updateTrigger(delta) {
    const trigger = this.references.trigger;
    if (!trigger || !this.triggerBasePosition || this.triggerElapsed >= this.config.trigger.duration) return;

    this.triggerElapsed += delta;
    const progress = THREE.MathUtils.clamp(this.triggerElapsed / this.config.trigger.duration, 0, 1);
    const amount = progress < 0.28
      ? easeOutCubic(progress / 0.28)
      : 1 - smoothstep((progress - 0.28) / 0.72);
    trigger.position.copy(this.triggerBasePosition)
      .addScaledVector(this.triggerTravelDirection, this.triggerLocalTravel * amount);
    if (progress >= 1) trigger.position.copy(this.triggerBasePosition);
  }

  beginReload() {
    if (!this.baseMagazine || !this.magazineTemplate) return false;
    this.reloadAnimationActive = true;
    this.reloadMagazineSwapped = false;
    this.reloadBoltActive = false;
    this.pendingShellEject = null;
    this.boltShellEjected = true;
    return true;
  }

  updateReload(progress) {
    if (!this.reloadAnimationActive || !this.currentMagazine) return;
    const clamped = THREE.MathUtils.clamp(progress, 0, 1);
    const config = this.config.magazine;

    if (!this.reloadMagazineSwapped && clamped < config.removeEnd) {
      const phase = inverseRange(config.removeStart, config.removeEnd, clamped);
      this.animateMagazine(
        this.currentMagazine,
        this.magazineBasePosition,
        this.magazineOutPosition,
        this.magazineBaseQuaternion,
        this.magazineOutQuaternion,
        phase,
      );
    }

    if (!this.reloadMagazineSwapped && clamped >= config.removeEnd) {
      this.swapMagazine();
    }

    if (this.reloadMagazineSwapped && this.magazineReplacement) {
      if (clamped >= config.insertStart) {
        this.magazineReplacement.visible = true;
      }
      const phase = inverseRange(config.insertStart, config.insertEnd, clamped);
      this.animateMagazine(
        this.magazineReplacement,
        this.magazineOutPosition,
        this.magazineBasePosition,
        this.magazineOutQuaternion,
        this.magazineBaseQuaternion,
        phase,
      );
    }

    if (clamped >= config.cockStart) {
      this.updateReloadBolt(inverseRange(config.cockStart, config.cockEnd, clamped));
    }
  }

  updateReloadBolt(phase) {
    const clamped = THREE.MathUtils.clamp(phase, 0, 1);
    const amount = clamped < 0.45
      ? easeOutCubic(clamped / 0.45)
      : 1 - smoothstep((clamped - 0.45) / 0.55);

    const bolt = this.references.bolt;
    if (bolt && this.boltBasePosition) {
      bolt.position.copy(this.boltBasePosition)
        .addScaledVector(this.boltTravelDirection, this.boltLocalTravel * amount);
      if (clamped >= 1) bolt.position.copy(this.boltBasePosition);
    }
    this.reloadBoltActive = clamped < 1;

    const ch = this.references.chargingHandle;
    if (ch && this.chargingHandleBasePosition) {
      ch.position.copy(this.chargingHandleBasePosition)
        .addScaledVector(this.chargingHandleTravelDirection, this.chargingHandleLocalTravel * amount);
      if (clamped >= 1) ch.position.copy(this.chargingHandleBasePosition);
    }
  }

  animateMagazine(object, fromPosition, toPosition, fromQuaternion, toQuaternion, phase) {
    const eased = smoothstep(THREE.MathUtils.clamp(phase, 0, 1));
    object.position.lerpVectors(fromPosition, toPosition, eased);
    object.quaternion.copy(fromQuaternion).slerp(toQuaternion, eased);
  }

  swapMagazine() {
    const removed = this.currentMagazine;
    if (!removed) return;

    // Clone the removed magazine for physics drop before hiding it
    if (this.onMagazineDrop) {
      removed.updateWorldMatrix(true, false);
      const droppedMag = this.magazineTemplate.clone(true);
      const worldPos = removed.getWorldPosition(new THREE.Vector3());
      const worldQuat = removed.getWorldQuaternion(new THREE.Quaternion());
      const worldScale = removed.getWorldScale(new THREE.Vector3());
      this.onMagazineDrop(droppedMag, worldPos, worldQuat, worldScale);
    }

    removed.visible = false;
    if (removed !== this.baseMagazine) removed.parent?.remove(removed);

    const replacement = this.magazineTemplate.clone(true);
    replacement.visible = false;
    replacement.position.copy(this.magazineOutPosition);
    replacement.quaternion.copy(this.magazineOutQuaternion);
    replacement.scale.copy(this.magazineBaseScale);
    this.magazineParent.add(replacement);

    this.magazineReplacement = replacement;
    this.currentMagazine = replacement;
    this.reloadMagazineSwapped = true;
  }

  finishReload() {
    if (!this.reloadAnimationActive) return;
    if (this.magazineReplacement) {
      this.magazineReplacement.visible = true;
      this.magazineReplacement.position.copy(this.magazineBasePosition);
      this.magazineReplacement.quaternion.copy(this.magazineBaseQuaternion);
      this.magazineReplacement.scale.copy(this.magazineBaseScale);
      this.currentMagazine = this.magazineReplacement;
    } else {
      this.restoreMagazine();
    }
    this.reloadAnimationActive = false;
    this.reloadMagazineSwapped = false;
    this.reloadBoltActive = false;
    if (this.references.bolt && this.boltBasePosition) this.references.bolt.position.copy(this.boltBasePosition);
  }

  cancelReload() {
    if (this.magazineReplacement?.parent) this.magazineReplacement.parent.remove(this.magazineReplacement);
    this.magazineReplacement = null;
    this.reloadAnimationActive = false;
    this.reloadMagazineSwapped = false;
    this.reloadBoltActive = false;
    if (this.references.bolt && this.boltBasePosition) this.references.bolt.position.copy(this.boltBasePosition);
    this.restoreMagazine();
  }

  reset() {
    this.cancelReload();
    if (this.references.bolt && this.boltBasePosition) this.references.bolt.position.copy(this.boltBasePosition);
    if (this.references.trigger && this.triggerBasePosition) {
      this.references.trigger.position.copy(this.triggerBasePosition);
    }
    this.boltElapsed = Infinity;
    this.triggerElapsed = Infinity;
    this.pendingShellEject = null;
    this.boltShellEjected = true;
    if (this.references.bulletTemplate) this.references.bulletTemplate.visible = false;
    if (this.references.shellTemplate) this.references.shellTemplate.visible = false;
    this.setAdsVisibility(false);
  }

  restoreMagazine() {
    if (!this.baseMagazine) return;
    this.baseMagazine.visible = true;
    this.baseMagazine.position.copy(this.magazineBasePosition);
    this.baseMagazine.quaternion.copy(this.magazineBaseQuaternion);
    this.baseMagazine.scale.copy(this.magazineBaseScale);
    this.currentMagazine = this.baseMagazine;
  }

  getMuzzlePosition(positionTarget) {
    const point = this.references.muzzlePoint;
    if (!point) return false;
    point.getWorldPosition(positionTarget);
    return true;
  }

  setAdsVisibility(visible) {
    if (this.references.redDot) this.references.redDot.visible = Boolean(visible);
  }

  getAimReference() {
    return this.references.aimPoint ?? this.references.adsAim ?? this.references.redDot ?? null;
  }

  getGunBasis(rightTarget, upTarget, backwardTarget) {
    const rotation = this.model.getWorldQuaternion(new THREE.Quaternion());
    rightTarget.set(1, 0, 0).applyQuaternion(rotation).normalize();
    upTarget.set(0, 1, 0).applyQuaternion(rotation).normalize();
    backwardTarget.copy(this.muzzleDirectionLocal).negate().applyQuaternion(rotation).normalize();
    return Boolean(this.references.muzzlePoint && this.muzzleDirectionValid);
  }

  getMuzzleTransform(positionTarget, directionTarget) {
    const point = this.references.muzzlePoint;
    if (!point || !this.muzzleDirectionValid) return false;
    point.getWorldPosition(positionTarget);
    point.getWorldDirection(directionTarget);
    return directionTarget.dot(this.muzzleDirection) >= 0.985;
  }

  getShellTransform(positionTarget) {
    const point = this.references.shellEjectPoint;
    if (!point) return false;
    point.getWorldPosition(positionTarget);
    return true;
  }
}

function largestGeometryAxis(object) {
  const box = new THREE.Box3().setFromObject(object, true);
  if (box.isEmpty()) return new THREE.Vector3(0, 0, 1);
  const size = box.getSize(new THREE.Vector3());
  if (size.x >= size.y && size.x >= size.z) return new THREE.Vector3(1, 0, 0);
  if (size.y >= size.z) return new THREE.Vector3(0, 1, 0);
  return new THREE.Vector3(0, 0, 1);
}

/** Collapses a node name to letters and digits so spacing/case never matter. */
function normalizeNodeName(name) {
  return String(name).toLowerCase().replace(/[^a-z0-9]/g, '');
}

function worldDirectionToParent(worldDirection, parent) {  const inverseParentRotation = parent.getWorldQuaternion(new THREE.Quaternion()).invert();
  return worldDirection.clone().applyQuaternion(inverseParentRotation).normalize();
}

function inverseRange(start, end, value) {
  if (end <= start) return value >= end ? 1 : 0;
  return THREE.MathUtils.clamp((value - start) / (end - start), 0, 1);
}

function smoothstep(value) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return clamped * clamped * (3 - (2 * clamped));
}

function easeOutCubic(value) {
  const clamped = THREE.MathUtils.clamp(value, 0, 1);
  return 1 - ((1 - clamped) ** 3);
}
