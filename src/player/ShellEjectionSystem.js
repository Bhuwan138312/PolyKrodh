import * as THREE from 'three';

export class ShellEjectionSystem {
  constructor({ scene, arena, config }) {
    this.scene = scene;
    this.arena = arena;
    this.config = config;
    this.shells = [];
    this.template = null;
    this.templateScale = new THREE.Vector3(1, 1, 1);
    // Reference rifle-casing proportions, in world metres. A .17 cartridge case
    // is roughly 63 mm long and 12.7 mm across, and the guns that ship a named
    // shell mesh eject at 0.021-0.050 m, so this sits with them instead of the
    // 0.0175 m sliver this used to be - which was barely half as long as the
    // rifle casings and read as a speck. A weapon whose casing is a different
    // size scales it via `config.size` rather than editing this.
    this.geometry = new THREE.CylinderGeometry(0.0062, 0.0055, 0.058, 10, 1, false);
    this.material = new THREE.MeshStandardMaterial({
      color: 0xc99a43,
      metalness: 0.82,
      roughness: 0.28,
    });
  }

  setTemplate(template, worldScale = null) {
    this.template = template?.isObject3D ? template : null;
    if (worldScale) this.templateScale.copy(worldScale);
    if (this.template) this.template.visible = false;
  }

  eject({ position, right, up, backward }) {
    while (this.shells.length >= this.config.maxActive) this.removeShell(this.shells[0]);

    let shell;
    if (this.template) {
      shell = this.template.clone(true);
      shell.position.copy(position);
      shell.quaternion.setFromEuler(new THREE.Euler(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      ));
      // Multiply the scale by 0.5 to force the GLB model shell to be a reasonable size
      shell.scale.copy(this.templateScale).multiplyScalar(0.5 * (0.92 + Math.random() * 0.16));
      shell.visible = true;
    } else {
      shell = new THREE.Mesh(this.geometry, this.material);
      shell.position.copy(position);
      shell.rotation.set(
        Math.random() * Math.PI,
        Math.random() * Math.PI,
        Math.random() * Math.PI,
      );
      shell.scale.setScalar((0.9 + Math.random() * 0.2) * (this.config.size ?? 1));
    }
    shell.traverse((child) => {
      child.frustumCulled = false;
      if (child.isMesh) {
        child.castShadow = false;
        child.receiveShadow = false;
      }
    });
    this.scene.add(shell);

    const lateralSpeed = this.config.speed * (0.84 + Math.random() * 0.32);
    const upwardSpeed = this.config.lift * (0.8 + Math.random() * 0.4);
    const backwardSpeed = this.config.backwardSpeed * (0.78 + Math.random() * 0.44);
    const velocity = right.clone().multiplyScalar(lateralSpeed)
      .addScaledVector(up, upwardSpeed)
      .addScaledVector(backward, backwardSpeed);

    this.shells.push({
      mesh: shell,
      velocity,
      angularVelocity: new THREE.Vector3(
        (Math.random() - 0.5) * 24,
        (Math.random() - 0.5) * 24,
        (Math.random() - 0.5) * 24,
      ),
      age: 0,
      bounces: 0,
    });
  }

  update(delta) {
    for (let index = this.shells.length - 1; index >= 0; index -= 1) {
      const shell = this.shells[index];
      shell.age += delta;
      if (shell.age >= this.config.lifetime) {
        this.removeShell(shell);
        continue;
      }

      shell.velocity.y -= this.config.gravity * delta;
      const nextPosition = shell.mesh.position.clone().addScaledVector(shell.velocity, delta);
      const ground = this.arena.getGroundHeight(
        shell.mesh.position,
        0.04,
        shell.mesh.position.y,
        nextPosition.y,
        Math.max(3, Math.abs(shell.velocity.y) * delta + 0.5),
      );

      if (nextPosition.y <= ground + 0.018 && shell.velocity.y < 0) {
        nextPosition.y = ground + 0.018;
        if (shell.bounces < 1 && Math.abs(shell.velocity.y) > 0.7) {
          shell.velocity.y *= -0.24;
          shell.velocity.x *= 0.68;
          shell.velocity.z *= 0.68;
          shell.angularVelocity.multiplyScalar(0.72);
          shell.bounces += 1;
        } else {
          shell.velocity.set(0, 0, 0);
          shell.angularVelocity.multiplyScalar(Math.exp(-8 * delta));
        }
      }

      shell.mesh.position.copy(nextPosition);
      shell.mesh.rotation.x += shell.angularVelocity.x * delta;
      shell.mesh.rotation.y += shell.angularVelocity.y * delta;
      shell.mesh.rotation.z += shell.angularVelocity.z * delta;
    }
  }

  removeShell(shell) {
    const index = this.shells.indexOf(shell);
    if (index >= 0) this.shells.splice(index, 1);
    this.scene.remove(shell.mesh);
  }

  clear() {
    for (const shell of this.shells) this.scene.remove(shell.mesh);
    this.shells.length = 0;
  }
}
