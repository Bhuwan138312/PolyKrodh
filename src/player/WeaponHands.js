import * as THREE from 'three';

const RIGHT_GRIP_NAMES = ['ddmk18_grip_16', 'ak200_grip_13', 'RightGrip', 'Pistol_Grip', 'PistolGrip'];
const SUPPORT_GRIP_NAMES = ['ddmk18_handguard_15', 'ak200_handguard_11', 'SupportGrip', 'Handguard_Railed', 'handguard', 'Handguard'];

export class WeaponHands {
  constructor({ model, asset, isPistol = false, handAnchors = null, fallbackHandsSource = null }) {
    this.model = model;
    this.asset = asset;
    this.isPistol = isPistol;
    this.handAnchors = handAnchors;
    this.fallbackHandsSource = fallbackHandsSource;
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
    this.rightHand = this.createBlockyArm('RightHand', rightPosition, false);
    this.leftHand = this.createBlockyArm('LeftHand', supportPosition, true);
    this.group.add(this.rightHand, this.leftHand);
    this.model.add(this.group);

    this.leftHandBasePos = this.leftHand.position.clone();
    this.leftHandBaseRot = this.leftHand.rotation.clone();
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
