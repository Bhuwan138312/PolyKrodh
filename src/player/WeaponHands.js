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
  grab: 0.28,   // hand has arrived at the ammunition and closes on the round
  carry: 0.40,   // round is picked up and starts toward the port
  align: 0.64,   // round is squared up with the tube axis, nose at the mouth
  insert: 0.80,  // pushed down the tube - the frame the shell count rises on
  follow: 0.92,  // hand carries through past the port and settles
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
  updateShellLoad({ beat = -1, phase = 0, delta = 0, insertPoint = null, insertDir = null } = {}) {
    if (!this.leftHand) return;

    // A port is required: the whole animation is built around feeding a round
    // into it, and guessing one would put shells in the wrong place on a model
    // that ships its own. The gun leaves the hand on the grip and still reloads.
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

    // Where the round lives relative to the fist, and where the fist has to
    // stand for the round's nose to reach a given point on the tube.
    const shellFromHand = dir.clone().multiplyScalar(HAND_TO_NOSE - (SHELL_LENGTH / 2));
    const handFromNose = dir.clone().multiplyScalar(-HAND_TO_NOSE);
    const source = port.clone().add(SOURCE_OFFSET);
    // Square with the tube: the round's nose is here, the brass is HAND_TO_NOSE
    // further back, and the fist that far behind that.
    const alignHand = port.clone().add(handFromNose);
    // Pushed all the way in, so the round is inside the tube rather than at its
    // mouth - the hand follows it in and then settles just short of the port.
    const insertHand = port.clone().add(handFromNose).addScaledVector(dir, SHELL_LENGTH);

    const b = SHELL_LOAD_BEAT;

    // Cache where this beat started, so the hand travels from its real current
    // pose rather than snapping to a stored one. Re-read on a new beat, and on
    // one that restarts rather than continues: `reached` records that this
    // beat's reach has already been played out, so coming back to it - a
    // reload that starts again while the hand is still walking back to the grip
    // lands on the same beat number - reads the pose the hand is genuinely in.
    // Re-reading mid-beat is harmless for the later phases, which aim at
    // absolute points and never consult this.
    if (state.beat !== beat || state.reached || phase < state.startPhase) {
      state.beat = beat;
      state.reached = false;
      state.startPhase = phase;
      state.startPos.copy(this.leftHand.position);
      state.startQuat.copy(this.leftHand.quaternion);
      state.returning = false;
    }
    if (phase >= b.grab) state.reached = true;

    const shellQuat = new THREE.Quaternion().setFromUnitVectors(UP, dir);
    let handTarget = alignHand;    let handQuat = shellQuat;
    let shellVisible = true;
    let shellCentre = alignHand.clone().add(shellFromHand);

    if (phase < b.grab) {
      // Reach down to the belt. Slowing into the end so the arrival reads as a
      // grab rather than a pass-by.
      const t = smootherstep(phase / b.grab);
      handTarget = state.startPos.clone().lerp(source, t);
      // Wrist rolls over as the hand goes down for the round.
      handQuat = state.startQuat.clone().slerp(shellQuat, t * 0.6);
      // Nothing in the fist yet.
      shellVisible = false;
    } else if (phase < b.carry) {
      // Fingers close on the round. The shell appears here, at the ammunition,
      // and from here on it is the same object riding the whole way in.
      const t = easeOutCubic((phase - b.grab) / (b.carry - b.grab));
      handTarget = source;
      // A short curl toward the palm, then back out as the hand lifts - the
      // close and the release are the only finger motion in the cycle.
      const curl = Math.sin(t * Math.PI) * 0.5;
      handQuat = shellQuat.clone().multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(curl * 0.5, 0, 0)),
      );
      shellCentre = source.clone().add(shellFromHand);
    } else if (phase < b.align) {
      // Carry it to the port, nose leading along the tube axis.
      const t = smootherstep((phase - b.carry) / (b.align - b.carry));
      handTarget = source.clone().lerp(alignHand, t);
      handQuat = shellQuat.clone().multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(Math.sin(t * Math.PI) * 0.18, 0, 0)),
      );
      shellCentre = handTarget.clone().add(shellFromHand);
    } else if (phase < b.insert) {
      // Square the last of the travel: the round rotates onto the tube axis and
      // creeps the rest of the way to the mouth. Separate from the push so the
      // aim and the force are two readable movements.
      const t = easeOutCubic((phase - b.align) / (b.insert - b.align));
      handTarget = alignHand;
      handQuat = shellQuat.clone().multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler((1 - t) * 0.16, 0, 0)),
      );
      shellCentre = alignHand.clone().add(shellFromHand);
    } else if (phase < b.follow) {
      // The push. Accelerating in, so it reads as force rather than a slide.
      const t = easeInCubic((phase - b.insert) / (b.follow - b.insert));
      handTarget = alignHand.clone().lerp(insertHand, t);
      handQuat = shellQuat;
      shellCentre = handTarget.clone().add(shellFromHand);
    } else {
      // Follow through: the hand carries a little past the port, then settles
      // back onto the hold. It starts from exactly where the push ended, so the
      // two join without a step. By now the round is inside the tube, which is
      // what hides it - it is never switched off mid-travel.
      const t = easeOutCubic((phase - b.follow) / (1 - b.follow));
      const carry = Math.sin(t * Math.PI);
      handTarget = insertHand.clone().addScaledVector(dir, SHELL_LENGTH * 0.18 * carry);
      handQuat = shellQuat.clone().multiply(
        new THREE.Quaternion().setFromEuler(new THREE.Euler(carry * 0.22, 0, 0)),
      );
      shellCentre = handTarget.clone().add(shellFromHand);
      // Inside the tube, behind its own geometry.
      shellVisible = false;
    }

    this.leftHand.position.copy(handTarget);
    this.leftHand.quaternion.copy(handQuat);

    this.shellProp.visible = shellVisible;
    if (shellVisible) {
      this.shellProp.position.copy(shellCentre);
      this.shellProp.quaternion.copy(shellQuat);
    }
  }

  /**
   * The walk back to the grip after the last round, run off a real clock rather
   * than the reload's own progress: the reload is over, but the hand still has
   * to get there. Fades in from wherever the hand actually stopped, so
   * cancelling a reload mid-beat does not snap it.
   */
  updateShellReturn(delta) {
    const state = this.shellLoad;
    if (!this.hasShellInsert) {
      this.restLeftHand();
      return;
    }

    if (!state.returning) {
      state.returning = true;
      // The cached beat is meaningless with no load in progress, and dropping it
      // is what makes a reload that starts while the hand is still walking back
      // re-read its start pose instead of reaching for the pose the cancelled
      // reload left behind.
      state.beat = -1;
      state.returnElapsed = 0;
      state.returnFrom.copy(this.leftHand.position);
      state.returnFromQuat.copy(this.leftHand.quaternion);
    }

    state.returnElapsed += delta;
    const t = Math.min(1, state.returnElapsed / SHELL_RETURN_DURATION);
    // Ease in and out, and land exactly on the rest pose rather than near it.
    const eased = t >= 1 ? 1 : smootherstep(t);
    this.leftHand.position.copy(state.returnFrom).lerp(this.leftHandBasePos, eased);
    this.leftHand.quaternion.copy(state.returnFromQuat).slerp(this.leftHandBaseQuat, eased);

    this.shellProp.visible = false;

    if (t >= 1) {
      state.returning = false;
      state.beat = -1;
      this.restLeftHand();
    }
  }

  /** The support hand, parked on its rest pose with no round in it. */
  restLeftHand() {
    this.leftHand.position.copy(this.leftHandBasePos);
    this.leftHand.rotation.copy(this.leftHandBaseRot);
    this.shellProp.visible = false;
  }

  /**
   * Drops any in-flight shell load and puts the hand back on the grip. Called
   * when a match resets, so a reload that was cut off by a death or a weapon
   * switch does not leave a round stuck to the fist or the hand stranded at the
   * loading port.
   */
  resetShellLoad() {
    this.shellLoad.beat = -1;
    this.shellLoad.startPhase = 0;
    this.shellLoad.reached = false;
    this.shellLoad.returning = false;
    this.shellLoad.returnElapsed = 0;
    this.restLeftHand();
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
