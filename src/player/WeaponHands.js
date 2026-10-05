import * as THREE from 'three';

const RIGHT_GRIP_NAMES = ['ddmk18_grip_16', 'ak200_grip_13', 'RightGrip', 'Pistol_Grip', 'PistolGrip'];
const SUPPORT_GRIP_NAMES = ['ddmk18_handguard_15', 'ak200_handguard_11', 'SupportGrip', 'Handguard_Railed', 'handguard', 'Handguard'];

/**
 * One shell-loading beat, as fractions of the per-shell interval.
 *
 * Exported because the ammo count has to rise on the same frame the round goes
 * in, not on the beat boundary - otherwise the HUD ticks a shell up while the
 * hand is still on its way to the tube and the two disagree.
 *
 * The beat is deliberately packed: a 12-gauge round goes in on one smooth push,
 * so a 0.24s interval is six overlapping eased segments rather than six stops.
 * Anything held at full extension reads as a freeze, and the curve never settles
 * between segments.
 */
export const SHELL_LOAD_BEAT = Object.freeze({
  grab: 0.28,    // hand arrives at belt/pouch and grabs shell
  align: 0.62,   // hand brings shell up to loading port entrance
  insert: 0.80,  // hand pushes shell completely into the tube
  follow: 0.92,  // brief settle before next shell
});

/** A 12-gauge round: 60 mm long, 18.5 mm across the brass. */
const SHELL_LENGTH = 0.060;
const SHELL_RADIUS = 0.0092;
/** Brass head, so the base reads as the part that goes in first. */
const SHELL_HEAD_LENGTH = 0.016;
/** How far ahead of the fist the round's nose sits, which is what sets how far
 *  back from the port the hand has to stand for the nose to reach the mouth. */
const HAND_TO_NOSE = 0.075;
/** Where the next round is picked up, relative to the port in model space: down
 *  and inboard, so the hand dips toward the shooter's belt and comes back up. */
const SOURCE_OFFSET = new THREE.Vector3(-0.10, -0.15, 0.10);
/** How long the hand takes to get back to the grip once the last round is in. */
const SHELL_RETURN_DURATION = 0.26;
/** The shell prop is built nose-up along +Y, so this is what it gets aimed by. */
const UP = new THREE.Vector3(0, 1, 0);

const clamp01 = (value) => (value < 0 ? 0 : value > 1 ? 1 : value);
const easeInCubic = (t) => clamp01(t) ** 3;
const easeOutCubic = (t) => 1 - ((1 - clamp01(t)) ** 3);
const easeInOutQuad = (t) => { const c = clamp01(t); return c < 0.5 ? 2 * c * c : 1 - Math.pow(-2 * c + 2, 2) / 2; };
/**
 * Smootherstep. The gentlest of the curves, and the one the long reaches use.
 *
 * The belt-to-port travel is the single biggest movement in the reload, and at
 * 0.24s a shell it gets barely four frames. A cubic ease-in-out spends most of
 * those in its fast middle, which showed up as one frame covering three times
 * the distance of the one after it - a visible spike rather than a sweep.
 * Smootherstep has no acceleration term at either end, so the same four frames
 * read as a continuous move.
 */
const smootherstep = (t) => {
  const c = clamp01(t);
  return c * c * c * (c * (c * 6 - 15) + 10);
};

export class WeaponHands {
  constructor({ model, asset, isPistol = false, handAnchors = null, fallbackHandsSource = null, leftHandOffset = null, showRightHand = true }) {
    this.model = model;
    this.asset = asset;
    this.isPistol = isPistol;
    this.handAnchors = handAnchors;
    this.fallbackHandsSource = fallbackHandsSource;
    this.leftHandOffset = leftHandOffset;
    this.showRightHand = showRightHand;
    this.group = null;
    this.rightHand = null;
    this.leftHand = null;
    this.build();
  }

  build() {
    this.model.updateWorldMatrix(true, true);
    const rightAnchor = this.findAnchor(RIGHT_GRIP_NAMES);
    const supportAnchor = this.findAnchor(SUPPORT_GRIP_NAMES);

    // Explicit anchors win, then a grip/handguard node from the GLB, then the
    // generic fallback. Models that ship their weapon as one merged mesh have no
    // per-part nodes to hang the fists off, so those pass handAnchors instead.
    const rightPosition = this.handAnchors?.right?.clone()
      ?? (rightAnchor
        ? this.anchorPoint(rightAnchor)
        : new THREE.Vector3(0.015, -0.05, 0.12));

    // createBlockyArm offsets the support fist down and inboard from its anchor,
    // so an explicit support anchor has to allow for that to land on the part.
    const supportPosition = this.handAnchors?.support?.clone()
      ?? (supportAnchor
        ? this.anchorPoint(supportAnchor)
        : (this.isPistol
          ? new THREE.Vector3(-0.015, -0.05, 0.12) // Perfectly symmetrical to right hand
          : new THREE.Vector3(0.0, 0.10, -0.20)));

    if (this.handAnchors?.support || supportAnchor) {
      // Undo the generic support drop/inboard so the given value is where the
      // fist itself ends up rather than where its anchor sits.
      supportPosition.x += 0.04;
      supportPosition.y += 0.11;
      supportPosition.z -= 0.08; // Push hand further forward along the handguard
    }

    this.group = new THREE.Group();
    this.group.name = 'FirstPersonHands';
    // The grip hand is not built at all when a gun opts out, rather than being
    // built and hidden: nothing else in the game reads `rightHand`, so there is
    // no dead geometry left in the scene and no cost to skip it.
    if (this.showRightHand) this.rightHand = this.createBlockyArm('RightHand', rightPosition, false);
    this.leftHand = this.createBlockyArm('LeftHand', supportPosition, true);

    // Per-weapon nudge of the support fist, in model space. Model space is
    // camera-aligned here (WeaponModel is an identity child of the holder, which
    // is an identity child of the camera, carrying only a uniform viewScale), so
    // +Z runs back toward the eye and -Y is down. Applied AFTER the generic
    // support drop so it is a true offset from where the fist actually lands,
    // and BEFORE the base clone below so the reload animation still returns to
    // this hand's rest pose rather than snapping away from it.
    if (this.leftHandOffset) this.leftHand.position.add(this.leftHandOffset);

    // The rest pose is read only once the hand is parented, so it is the pose
    // the hand actually holds rather than whatever it was carrying mid-build.
    this.leftHandBasePos = this.leftHand.position.clone();
    this.leftHandBaseRot = this.leftHand.rotation.clone();
    this.leftHandBaseQuat = this.leftHand.quaternion.clone();

    if (this.rightHand) {
      this.rightHandBasePos = this.rightHand.position.clone();
      this.rightHandBaseRot = this.rightHand.rotation.clone();
      this.rightHandBaseQuat = this.rightHand.quaternion.clone();
    }

    this.group.add(this.leftHand);
    if (this.rightHand) this.group.add(this.rightHand);
    this.model.add(this.group);

    // The round the support hand feeds into the tube. Built once and parented to
    // the model rather than to the hand, because it has to end up square with the
    // tube axis while it goes in - the hand's own wrist angle is free to stay
    // wherever the arm needs it.
    this.shellProp = this.createShellProp();
    this.shellProp.visible = false;
    this.model.add(this.shellProp);

    // Tubular reload state. `beat` is which round the cached start pose belongs
    // to, so a reload that starts mid-swing eases from wherever the hand actually
    // is rather than snapping to a stored pose.
    this.shellLoad = {
      beat: -1,
      startPhase: 0,
      reached: false,
      startPos: this.leftHandBasePos.clone(),
      startQuat: new THREE.Quaternion(),
      returning: false,
      returnElapsed: 0,
      returnFrom: this.leftHandBasePos.clone(),
      returnFromQuat: new THREE.Quaternion(),
    };
    // The port and tube axis, handed in by the weapon whenever it reloads.
    this.shellInsertPoint = new THREE.Vector3();
    this.shellInsertDir = new THREE.Vector3(0, 0, -1);
    this.hasShellInsert = false;
  }

  updateReload(progress) {
    if (!this.leftHand) return;

    // config.js timings: removeStart 0.05, removeEnd 0.15, insertStart 0.55, insertEnd 0.85
    if (progress <= 0 || progress >= 1) {
      this.leftHand.position.copy(this.leftHandBasePos);
      this.leftHand.rotation.copy(this.leftHandBaseRot);
      return;
    }

    const magPos = new THREE.Vector3(0.02, -0.15, 0.05);
    const magRot = new THREE.Euler(0.4, -0.1, 0);
    const throwPos = new THREE.Vector3(-0.3, -0.3, 0.1);
    const throwRot = new THREE.Euler(0.8, -0.6, -0.5);
    const offscreenPos = new THREE.Vector3(-0.1, -0.6, 0.2);
    const insertStartPos = new THREE.Vector3(0.02, -0.5, 0.05);

    const cockPos = new THREE.Vector3(-0.04, 0.06, 0.20);
    const cockPulledPos = new THREE.Vector3(-0.04, 0.06, 0.35);
    const cockRot = new THREE.Euler(0.5, 0.2, -0.2);

    const lerpTransform = (p1, p2, r1, r2, t) => {
      this.leftHand.position.lerpVectors(p1, p2, t);
      const q1 = new THREE.Quaternion().setFromEuler(r1 instanceof THREE.Euler ? r1 : new THREE.Euler().setFromVector3(r1));
      const q2 = new THREE.Quaternion().setFromEuler(r2 instanceof THREE.Euler ? r2 : new THREE.Euler().setFromVector3(r2));
      this.leftHand.quaternion.slerpQuaternions(q1, q2, t);
    };

    const easeOutCubic = (t) => 1 - Math.pow(1 - t, 3);
    const easeInOutQuad = (t) => t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;

    if (progress < 0.10) {
      // 1. Move from barrel to mag smoothly
      const t = easeInOutQuad(progress / 0.10);
      lerpTransform(this.leftHandBasePos, magPos, this.leftHandBaseRot, magRot, t);
    } else if (progress < 0.20) {
      // 2. Pull mag and throw
      const t = easeOutCubic((progress - 0.10) / 0.10);
      lerpTransform(magPos, throwPos, magRot, throwRot, t);
    } else if (progress < 0.35) {
      // 3. Drop hand offscreen
      const t = (progress - 0.20) / 0.15;
      lerpTransform(throwPos, offscreenPos, throwRot, throwRot, Math.min(1, t * 1.5));
    } else if (progress < 0.45) {
      // 4. Move up with new mag
      const t = easeOutCubic((progress - 0.35) / 0.10);
      lerpTransform(offscreenPos, insertStartPos, throwRot, magRot, t);
    } else if (progress < 0.65) {
      // 5. Insert mag
      const t = easeInOutQuad((progress - 0.45) / 0.20);
      lerpTransform(insertStartPos, magPos, magRot, magRot, t);
    } else if (progress < 0.80) {
      // 6. Move hand from mag to charging handle (Doubled reach time)
      const t = easeInOutQuad((progress - 0.65) / 0.15);
      lerpTransform(magPos, cockPos, magRot, cockRot, t);
    } else if (progress < 0.89) {
      // 7. Pull charging handle back (Much slower)
      const t = easeInOutQuad((progress - 0.80) / 0.09);
      lerpTransform(cockPos, cockPulledPos, cockRot, cockRot, t);
    } else {
      // 8. Release charging handle and return to barrel smoothly
      const t = easeInOutQuad((progress - 0.89) / 0.11);
      lerpTransform(cockPulledPos, this.leftHandBasePos, cockRot, this.leftHandBaseRot, t);
    }
  }

  /**
   * The tubular reload: the support hand leaves the grip, picks a round off the
   * shooter's belt, feeds it into the model's own loading port, and comes back
   * for the next one. This is the shotgun's reload; `updateReload` above stays
   * the magazine swap and is never called for it.
   *
   * `beat` is the zero-based round being loaded and `phase` how far through that
   * round's beat the reload is, 0 to 1. `insertPoint` and `insertDir` are the
   * tube mouth and the axis it runs along, both in model space, resolved from the
   * GLB by GLBWeaponRig - nothing here is placed by eye.
   *
   * Called every frame while the gun reloads, and again with no `beat` once it
   * stops, so the hand can finish its walk back to the grip after the last round
   * instead of being left hanging at the port.
   */
  /**
   * The tubular reload: the left support hand moves down to grab a 12-gauge round,
   * brings it up directly underneath the loading port, and pushes it forward
   * into the magazine tube. Repeats smoothly for each missing shell.
   *
   * The arm rotation is strictly constrained so the sleeve always points
   * down and back into the player's body/shoulder (natural kinematics),
   * never inverting or pointing into the sky.
   */
  updateShellLoad({ beat = -1, phase = 0, delta = 0, isLast = false, insertPoint = null, insertDir = null } = {}) {
    if (!this.leftHand) return;

    if (insertPoint) {
      this.shellInsertPoint.copy(insertPoint);
      if (insertDir && insertDir.lengthSq() > 1e-8) this.shellInsertDir.copy(insertDir).normalize();
      this.hasShellInsert = true;
    }

    if (beat < 0 || !this.hasShellInsert) {
      this.updateShellReturn(delta);
      return;
    }

    const state = this.shellLoad;
    const dir = this.shellInsertDir;
    const port = this.shellInsertPoint;

    // Cache start pose at the beginning of each beat
    if (state.beat !== beat || phase < state.startPhase) {
      state.beat = beat;
      state.startPhase = phase;
      state.startPos.copy(this.leftHand.position);
      state.startQuat.copy(this.leftHand.quaternion);
      state.returning = false;
    }

    // Key kinematics poses (in model space):
    // 1. Grab pose: hand reaches down-inboard towards shooter's belt/pouch
    const grabPos = new THREE.Vector3(-0.07, -0.22, 0.06);
    const grabQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.85, -0.35, -0.15));

    // 2. Align pose: hand positions the shell directly underneath the loading port mouth
    const alignPos = port.clone().add(new THREE.Vector3(-0.03, -0.04, 0.02));
    const alignQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.70, -0.42, -0.20));

    // 3. Insert pose: hand pushes forward along the tube axis
    const insertPos = alignPos.clone().addScaledVector(dir, 0.045);
    const insertQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.65, -0.45, -0.22));

    // Shell relative to the hand's palm:
    const shellLocalOffset = new THREE.Vector3(0.032, 0.022, -0.015);
    const shellQuat = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    const grabShellQuat = shellQuat.clone().multiply(new THREE.Quaternion().setFromEuler(new THREE.Euler(-0.35, 0, 0.12)));

    const b = SHELL_LOAD_BEAT;

    if (phase < b.grab) {
      // 1. Reach down for shell: hand travels from current pose to belt
      const t = smootherstep(phase / b.grab);
      this.leftHand.position.lerpVectors(state.startPos, grabPos, t);
      this.leftHand.quaternion.slerpQuaternions(state.startQuat, grabQuat, t);

      // Shell appears in hand as fingers close on it at the pouch
      if (phase >= b.grab * 0.55) {
        this.shellProp.visible = true;
        const shellPos = this.leftHand.position.clone().add(shellLocalOffset.clone().applyQuaternion(this.leftHand.quaternion));
        this.shellProp.position.copy(shellPos);
        this.shellProp.quaternion.copy(grabShellQuat);
      } else {
        this.shellProp.visible = false;
      }
    } else if (phase < b.align) {
      // 2. Bring shell up to the loading port
      const t = smootherstep((phase - b.grab) / (b.align - b.grab));
      this.leftHand.position.lerpVectors(grabPos, alignPos, t);
      this.leftHand.quaternion.slerpQuaternions(grabQuat, alignQuat, t);

      this.shellProp.visible = true;
      const shellPos = this.leftHand.position.clone().add(shellLocalOffset.clone().applyQuaternion(this.leftHand.quaternion));
      this.shellProp.position.copy(shellPos);
      this.shellProp.quaternion.copy(grabShellQuat.clone().slerp(shellQuat, t));
    } else if (phase < b.insert) {
      // 3. Push shell forward into the magazine tube
      const t = easeInCubic((phase - b.align) / (b.insert - b.align));
      this.leftHand.position.lerpVectors(alignPos, insertPos, t);
      this.leftHand.quaternion.slerpQuaternions(alignQuat, insertQuat, t);

      this.shellProp.visible = true;
      const shellPos = this.leftHand.position.clone().add(shellLocalOffset.clone().applyQuaternion(this.leftHand.quaternion));
      this.shellProp.position.copy(shellPos);
      this.shellProp.quaternion.copy(shellQuat);
    } else {
      // 4. Seated: Round is inside the tube (ammo increments, sound plays, kick bumps)
      this.shellProp.visible = false;

      // Follow-through: ease toward next round's grab position or back to handguard if last round
      const nextTargetPos = isLast ? this.leftHandBasePos : grabPos;
      const nextTargetQuat = isLast ? this.leftHandBaseQuat : grabQuat;
      const t = easeOutCubic((phase - b.insert) / (1.0 - b.insert));
      this.leftHand.position.lerpVectors(insertPos, nextTargetPos, t * 0.7);
      this.leftHand.quaternion.slerpQuaternions(insertQuat, nextTargetQuat, t * 0.7);
    }
  }

  /**
   * Smoothly returns the support hand back to the handguard grip once reload is over.
   */
  updateShellReturn(delta) {
    if (!this.leftHand) return;
    const state = this.shellLoad;
    if (this.shellProp) this.shellProp.visible = false;

    if (!state.returning) {
      state.returning = true;
      state.beat = -1;
      state.returnElapsed = 0;
      state.returnFrom.copy(this.leftHand.position);
      state.returnFromQuat.copy(this.leftHand.quaternion);
    }

    state.returnElapsed += delta;
    const t = Math.min(1, state.returnElapsed / SHELL_RETURN_DURATION);
    const eased = smootherstep(t);

    this.leftHand.position.lerpVectors(state.returnFrom, this.leftHandBasePos, eased);
    this.leftHand.quaternion.slerpQuaternions(state.returnFromQuat, this.leftHandBaseQuat, eased);

    if (t >= 1) {
      state.returning = false;
      this.restLeftHand();
    }
  }

  /** The support hand, parked on its rest pose with no round in it. */
  restLeftHand() {
    this.leftHand.position.copy(this.leftHandBasePos);
    this.leftHand.rotation.copy(this.leftHandBaseRot);
    this.leftHand.quaternion.copy(this.leftHandBaseQuat);
    if (this.shellProp) this.shellProp.visible = false;
  }

  /**
   * Post-reload charging handle pull: right hand reaches from the pistol grip
   * up to the charging handle on the right side of the receiver, pulls it back,
   * lets it snap forward, and returns to the grip.
   *
   * Returns charging handle travel offset (0 to 1) for the weapon model rig.
   */
  updateChargingHandlePull(progress) {
    if (!this.rightHand || !this.rightHandBasePos) return 0;

    const clamped = THREE.MathUtils.clamp(progress, 0, 1);
    if (clamped <= 0 || clamped >= 1) {
      this.rightHand.position.copy(this.rightHandBasePos);
      this.rightHand.quaternion.copy(this.rightHandBaseQuat);
      return 0;
    }

    const restPos = this.rightHandBasePos;
    const restQuat = this.rightHandBaseQuat;

    // Charging handle location on receiver (right side):
    const reachPos = new THREE.Vector3(0.055, 0.022, -0.11);
    const reachQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.55, 0.35, -0.12));

    // Pulled back position (~7cm rearward along receiver):
    const pulledPos = new THREE.Vector3(0.055, 0.022, -0.04);
    const pulledQuat = new THREE.Quaternion().setFromEuler(new THREE.Euler(0.58, 0.35, -0.12));

    let handleOffset = 0;

    if (clamped < 0.28) {
      // 1. Reach: hand moves up from pistol grip to charging handle
      const t = easeOutCubic(clamped / 0.28);
      this.rightHand.position.lerpVectors(restPos, reachPos, t);
      this.rightHand.quaternion.slerpQuaternions(restQuat, reachQuat, t);
      handleOffset = 0;
    } else if (clamped < 0.58) {
      // 2. Pull: hand pulls the charging handle back
      const t = easeInOutQuad((clamped - 0.28) / 0.30);
      this.rightHand.position.lerpVectors(reachPos, pulledPos, t);
      this.rightHand.quaternion.slerpQuaternions(reachQuat, pulledQuat, t);
      handleOffset = t;
    } else if (clamped < 0.68) {
      // 3. Release: bolt snaps forward into battery, hand lets go
      const t = easeInCubic((clamped - 0.58) / 0.10);
      handleOffset = 1 - t;
      const releasePos = pulledPos.clone().add(new THREE.Vector3(0.015, -0.01, 0.015));
      this.rightHand.position.lerpVectors(pulledPos, releasePos, t);
      this.rightHand.quaternion.slerpQuaternions(pulledQuat, restQuat, t * 0.25);
    } else {
      // 4. Return: hand returns from receiver down to the pistol grip
      const t = smootherstep((clamped - 0.68) / 0.32);
      const releasePos = pulledPos.clone().add(new THREE.Vector3(0.015, -0.01, 0.015));
      this.rightHand.position.lerpVectors(releasePos, restPos, t);
      this.rightHand.quaternion.slerpQuaternions(pulledQuat, restQuat, t);
      handleOffset = 0;
    }

    return handleOffset;
  }

  /**
   * Drops any in-flight shell load and smoothly returns hand to grip.
   */
  resetShellLoad() {
    this.shellLoad.beat = -1;
    this.shellLoad.startPhase = 0;
    this.shellLoad.reached = false;
    this.shellLoad.returning = false;
    this.shellLoad.returnElapsed = 0;
    this.restLeftHand();
    if (this.rightHand && this.rightHandBasePos) {
      this.rightHand.position.copy(this.rightHandBasePos);
      this.rightHand.rotation.copy(this.rightHandBaseRot);
      this.rightHand.quaternion.copy(this.rightHandBaseQuat);
    }
  }

  /**
   * One 12-gauge round, built along +Y with the nose up and the brass down, so
   * squaring it with the tube is a single setFromUnitVectors.
   *
   * Modelled rather than cloned from the GLB on purpose. shotgun.glb ships a
   * node named `bulletcell`, but it is a 29 mm disc floating above the receiver
   * rather than a round - cloning it handed the animation a puck with no length
   * to push into the tube. The gun's own `shell insert point` is still what the
   * round is aimed at, so the animation sits on the model's own geometry either
   * way; only the prop itself is procedural.
   */
  createShellProp() {
    const group = new THREE.Group();
    group.name = 'ShellLoadProp';

    const hullMaterial = new THREE.MeshStandardMaterial({
      color: 0x8c2320, roughness: 0.55, metalness: 0.05, flatShading: true,
    });
    const brassMaterial = new THREE.MeshStandardMaterial({
      color: 0xc99a43, roughness: 0.34, metalness: 0.75, flatShading: true,
    });

    const hullLength = SHELL_LENGTH - SHELL_HEAD_LENGTH;
    const hull = new THREE.Mesh(
      new THREE.CylinderGeometry(SHELL_RADIUS, SHELL_RADIUS, hullLength, 12, 1, false),
      hullMaterial,
    );
    // The nose sits at +SHELL_LENGTH / 2, so the hull starts half a head below.
    hull.position.y = (SHELL_LENGTH / 2) - SHELL_HEAD_LENGTH - (hullLength / 2);
    group.add(hull);

    // A closed crimp, so the front end is not an open tube facing the camera.
    const crimp = new THREE.Mesh(
      new THREE.CylinderGeometry(SHELL_RADIUS, SHELL_RADIUS, 0.004, 12, 1, false),
      hullMaterial,
    );
    crimp.position.y = (SHELL_LENGTH / 2) - 0.002;
    group.add(crimp);

    const head = new THREE.Mesh(
      new THREE.CylinderGeometry(SHELL_RADIUS, SHELL_RADIUS * 0.94, SHELL_HEAD_LENGTH, 12, 1, false),
      brassMaterial,
    );
    head.position.y = (-SHELL_LENGTH / 2) + (SHELL_HEAD_LENGTH / 2);
    group.add(head);

    // The rim, which is the part that actually stops against the tube mouth.
    const rim = new THREE.Mesh(
      new THREE.CylinderGeometry(SHELL_RADIUS * 1.06, SHELL_RADIUS * 1.06, 0.005, 12, 1, false),
      brassMaterial,
    );
    rim.position.y = (-SHELL_LENGTH / 2) + 0.0025;
    group.add(rim);

    // Primer cap on the brass base
    const primerMaterial = new THREE.MeshStandardMaterial({
      color: 0xb5b5b5, roughness: 0.3, metalness: 0.85, flatShading: true,
    });
    const primer = new THREE.Mesh(
      new THREE.CylinderGeometry(SHELL_RADIUS * 0.38, SHELL_RADIUS * 0.38, 0.006, 8, 1, false),
      primerMaterial,
    );
    primer.position.y = (-SHELL_LENGTH / 2) + 0.002;
    group.add(primer);

    group.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
    return group;
  }

  findAnchor(names) {
    for (const name of names) {
      const object = this.asset.getObjectByName(name);
      if (object) return object;
    }
    return null;
  }

  // Resolves an anchor node to the model-local point the fist should sit on.
  // Marker nodes (empty transforms) are already authored at that point, but some
  // models share a single pivot across every part, so when the anchor actually
  // carries geometry we use the centre of that mesh instead of its node origin.
  anchorPoint(anchor) {
    let worldPosition;
    if (anchor.isMesh) {
      const bounds = new THREE.Box3().setFromObject(anchor);
      worldPosition = bounds.isEmpty()
        ? anchor.getWorldPosition(new THREE.Vector3())
        : bounds.getCenter(new THREE.Vector3());
    } else {
      worldPosition = anchor.getWorldPosition(new THREE.Vector3());
    }
    return this.model.worldToLocal(worldPosition);
  }

  createBlockyArm(name, anchor, isSupport) {
    const armGroup = new THREE.Group();
    armGroup.name = name;

    // Position at the grip points
    armGroup.position.copy(anchor);

    // Materials - higher quality colors
    const skinMaterial = new THREE.MeshStandardMaterial({
      color: 0xe8ac7d, // Better skin tone
      roughness: 0.8,
      metalness: 0.1,
      flatShading: true,
    });
    const sleeveMaterial = new THREE.MeshStandardMaterial({
      color: 0x2b3036, // Deep dark grey/blue suit
      roughness: 0.9,
      metalness: 0.05,
      flatShading: true,
    });
    const cuffMaterial = new THREE.MeshStandardMaterial({
      color: 0xf0f0f0, // Clean white
      roughness: 1.0,
      metalness: 0.0,
      flatShading: true,
    });

    // We build the arm straight along the local +Z axis (backwards).
    // The hand is at the origin (0,0,0) attached to the gun.
    // The cuff is slightly behind the hand.
    // The sleeve is behind the cuff, extending far back.

    // 1. The Hand (Thick block)
    const handMesh = new THREE.Mesh(new THREE.BoxGeometry(0.10, 0.10, 0.10), skinMaterial);
    handMesh.position.set(0, 0, 0);
    armGroup.add(handMesh);

    // 2. The Cuff (Slightly larger than hand/sleeve to overlap cleanly)
    const cuffMesh = new THREE.Mesh(new THREE.BoxGeometry(0.115, 0.115, 0.045), cuffMaterial);
    cuffMesh.position.set(0, 0, 0.06); // Placed just behind the hand
    armGroup.add(cuffMesh);

    // 3. The Sleeve (Thick, very long block stretching down to the body)
    const sleeveLength = 1.8; // Very long so it never ends on-screen
    const sleeveMesh = new THREE.Mesh(new THREE.BoxGeometry(0.11, 0.11, sleeveLength), sleeveMaterial);
    sleeveMesh.position.set(0, 0, 0.08 + sleeveLength / 2); // Starts after the cuff
    armGroup.add(sleeveMesh);

    // Now we simply rotate the entire armGroup so the sleeve (local +Z) points where we want it to come from.
    if (isSupport) {
      if (this.isPistol) {
        // Pistol left hand (anchored at grip, arm slanted from far left)
        armGroup.position.x -= 0.045; // Moved further to the left
        armGroup.position.y -= 0.035;
        armGroup.position.z -= 0.06; // Moved further forward (away from camera)

        // Steep rotation so the arm originates from the far bottom-left corner
        armGroup.rotation.set(0.85, -0.9, -0.15);
        armGroup.scale.set(1.0, 1.0, 1.0); // Reset scale to normal
      } else {
        // Left Hand (Support) - Rifle
        armGroup.position.x -= 0.04;
        armGroup.position.y -= 0.11;
        armGroup.rotation.set(0.75, -0.4, -0.2);
      }
    } else {
      // Right Hand (Main Grip)
      if (this.isPistol) {
        armGroup.position.x += 0.025; // Shifted slightly left from previous edit
      } else {
        armGroup.position.x += 0.015;
      }
      armGroup.position.y -= 0.02;
      armGroup.rotation.set(0.7, 0.4, 0.0);
    }

    // Prevent shadow artifacts in first person
    armGroup.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
        child.userData.weaponHand = true;
      }
    });

    return armGroup;
  }
}
