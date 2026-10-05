import { io } from 'socket.io-client';
import * as THREE from 'three';
import { buildMinecraftCharacter, getBotSkin } from '../characters/MinecraftCharacter.js';
import { createHeldWeapon, disposeHeldWeapon, HELD_WEAPONS } from '../characters/HeldWeapons.js';

// Remote players wear the same blocky character the 1v1 duel opponent does.
// 'pro' is the duel bot's type, so `getBotSkin('pro')` hands back the real skin
// file Game.js loads at boot rather than a procedural one, and both read
// identically.
const REMOTE_SKIN = 'pro';

export class NetworkManager {
  constructor(game) {
    this.game = game;
    this.socket = null;
    this.connected = false;
    this.remotePlayers = new Map();

    // How often to send movement updates (e.g. 50ms)
    this.tickRate = 50;
    this.lastTickTime = 0;
    this.lastStateSyncTime = 0;
    // A remote cylinder stays drawn while the authoritative state says alive.
    // This is the only place in the codebase allowed to flip that visibility.
    this.DEATH_THRESHOLD = 0;
  }

  connect(serverAddress, roomName = 'Lobby', password = '') {
    const serverPort = window.location.port === '5173' ? ':3001' : (window.location.port ? ':' + window.location.port : '');
    const address = serverAddress || `${window.location.protocol}//${window.location.hostname}${serverPort}`;
    
    console.log(`Connecting to multiplayer server at: ${address}`);
    this.socket = io(address);
    this.lobbyPlayers = {};
    this.hostId = null;
    this.matchStarted = false;

    this.socket.on('connect', () => {
      console.log('Connected to server with ID:', this.socket.id);
      this.connected = true;
      this.socket.emit('joinRoom', { roomName, password }, (res) => {
        if (!res.success) {
          console.error('Failed to join room:', res.reason);
          this.disconnect();
          
          if (res.reason === 'Invalid password') {
            document.querySelector('#password-error').style.display = 'block';
            this.game.ui.show('password');
          } else {
            this.game.ui.show('menu');
          }
          return;
        }
        console.log(`Joined room: ${res.room}`);
        document.querySelector('#lobby-room-name').textContent = res.room;
        this.game.ui.show('lobby');
      });
    });

    this.socket.on('disconnect', () => {
      console.log('Disconnected from server');
      this.connected = false;
      this.clearRemotePlayers();
      this.game.scoreboard?.reset();
    });

    this.socket.on('roomStatus', (data) => {
      this.hostId = data.host;
      if (data.status === 'playing' && !this.matchStarted) {
        this.matchStarted = true;
        this.game.startMatch('normal', data.map || 'arena', true, false, roomName, true);
      }
    });

    this.socket.on('matchStarted', (mapName) => {
      this.matchStarted = true;
      this.game.startMatch('normal', mapName || 'arena', true, false, roomName, true);
    });

    // The server owns team membership and re-broadcasts the whole roster after
    // every change - a join, a team move, a disconnect, the match starting. This
    // is the only event that draws the lobby, so the screen cannot drift out of
    // step with the server by missing one update.
    this.socket.on('lobbyState', (state) => {
      if (!state || typeof state !== 'object') return;
      if (typeof state.host === 'string') this.hostId = state.host;
      if (this.matchStarted) return;
      this.game.ui.renderLobbyTeams(state, this.socket.id);
    });

    // When we first join, server sends us everyone already in the game
    this.socket.on('currentPlayers', (players) => {
      this.lobbyPlayers = players;

      Object.keys(players).forEach(id => {
        if (id === this.socket.id) return; // Don't add ourselves
        this.addRemotePlayer(players[id]);
      });
      if (this.matchStarted) {
        let myKills = 0, myDeaths = 0, otherKills = 0, otherDeaths = 0, otherCount = 0;
        for (const id in players) {
          if (id === this.socket.id) {
            myKills = players[id].kills || 0;
            myDeaths = players[id].deaths || 0;
          } else {
            otherKills += players[id].kills || 0;
            otherDeaths += players[id].deaths || 0;
            otherCount++;
          }
        }
        this.game.ui.updateMultiplayerScores(myKills, myDeaths, otherKills, otherDeaths, otherCount);
      }
      this.game.scoreboard?.sync(players, this.socket.id);
    });

    // When a new player joins while we are already in
    this.socket.on('newPlayer', (playerInfo) => {
      this.lobbyPlayers[playerInfo.id] = playerInfo;
      this.addRemotePlayer(playerInfo);
    });

    // When someone leaves
    this.socket.on('playerDisconnected', (id) => {
      delete this.lobbyPlayers[id];
      this.removeRemotePlayer(id);
      this.game.scoreboard?.remove(id);
    });

    // When someone switches weapon, so their character is holding the right gun
    this.socket.on('playerWeaponChanged', (data) => {
      if (!data || typeof data.id !== 'string') return;
      this.setRemoteWeapon(data.id, data.weaponIndex);
    });

    // When someone moves
    this.socket.on('playerMoved', (playerInfo) => {
      if (!playerInfo || typeof playerInfo.id !== 'string') return;
      const rp = this.remotePlayers.get(playerInfo.id);
      if (rp && this.matchStarted) {
        // We'll interpolate towards this position in the update loop
        rp.targetPosition.set(playerInfo.x, playerInfo.y, playerInfo.z);
        rp.targetRotation = playerInfo.ry;
      }
      // The server stamps the authoritative health/dead flag onto every
      // movement packet. Reconciling from it here is what stops a local
      // cylinder from ever drifting away from the server's verdict.
      if (playerInfo.health !== undefined || playerInfo.dead !== undefined) {
        this.applyRemoteState(playerInfo.id, {
          health: playerInfo.health,
          isAlive: playerInfo.dead !== undefined ? !playerInfo.dead : undefined,
        });
      }
    });

    // Authoritative health/death broadcast. This is the only signal allowed to
    // hide or show a remote player. Applying it is idempotent, so a snapshot
    // that merely repeats the current state can never hide a live player.
    this.socket.on('playerState', (state) => {
      if (!state || typeof state.id !== 'string') return;
      if (state.id === this.socket.id) {
        this.game.onAuthoritativeSelfState?.(state);
        return;
      }
      this.applyRemoteState(state.id, { health: state.health, isAlive: state.isAlive });
    });

    // When someone shoots
    this.socket.on('playerFired', (shotData) => {
      if (!shotData || !shotData.origin || !shotData.direction) return;
      // Find the remote player
      const rp = this.remotePlayers.get(shotData.id);
      if (rp) {
        // Recreate the bullet tracer and gunshot sound from their location
        const origin = new THREE.Vector3(shotData.origin.x, shotData.origin.y, shotData.origin.z);
        const direction = new THREE.Vector3(shotData.direction.x, shotData.direction.y, shotData.direction.z);
        
        // Play gunshot sound at their location
        this.game.audio.play('gunshot', origin);
        
        // Draw the tracer
        const target = origin.clone().add(direction.clone().multiplyScalar(50));
        this.game.effects.tracer(origin, target, true);

        // Kick the rifle they are holding, the same way the duel bot's own
        // recoil drives its gun, so the shot is visible on the character and
        // not just as a tracer across the world.
        rp.recoilKick = Math.min(1, (rp.recoilKick ?? 0) + 0.55);
      }
    });

    // When someone dies
    this.socket.on('playerDied', (data) => {
      if (!data || typeof data.victimId !== 'string') return;
      this.game.scoreboard?.setDead(data.victimId, true);
      if (data.victimId === this.socket.id) {
        // We died! The server already decided this, so our own health adopts
        // the authoritative 0 rather than inferring it from a hit.
        this.game.playerDiedLocally(data.killerId);
      } else {
        // Someone else died. Authoritative death, so hide them.
        const rp = this.remotePlayers.get(data.victimId);
        if (rp) {
          this.applyRemoteState(data.victimId, { health: 0, isAlive: false });
          this.game.ui.announceKill('ENEMY', 'PLAYER ' + data.victimId.substring(0, 4), 'assaultrifle', false, false);
        }
      }
    });

    this.socket.on('updateScores', (players) => {
      let myKills = 0, myDeaths = 0, otherKills = 0, otherDeaths = 0;
      let otherCount = 0;
      for (const pid in players) {
        if (pid === this.socket.id) {
          myKills = players[pid].kills || 0;
          myDeaths = players[pid].deaths || 0;
        } else {
          otherKills += players[pid].kills || 0;
          otherDeaths += players[pid].deaths || 0;
          otherCount++;
        }
      }
      this.game.ui.updateMultiplayerScores(myKills, myDeaths, otherKills, otherDeaths, otherCount);
      // Full authoritative snapshot - drives the top scoreboard.
      this.game.scoreboard?.sync(players, this.socket.id);
    });

    this.socket.on('matchFinished', (data) => {
      this.matchStarted = false;
      this.game.scoreboard?.reset();
      this.game.finishMultiplayerMatch(data.winner, data.stats);
    });

    // When someone respawns
    this.socket.on('playerRespawned', (playerInfo) => {
      this.respawnRemotePlayer(playerInfo);
    });

    // When we take damage from someone else
    this.socket.on('takeDamage', (data) => {
      if (!data) return;
      const damage = Number(data.damage);
      if (!Number.isFinite(damage) || damage <= 0) return;
      // Health only. This handler deliberately does not touch remote player
      // visibility, the death state, or the respawn timer - a non-lethal hit
      // must never be able to remove anybody.
      this.game.applyLocalDamage(damage, data.health);
    });
  }

  /**
   * The single gate for remote player liveness. Visibility is derived from the
   * authoritative state and nothing else, so a hit can never hide a player and
   * a state change can never leave a live player hidden.
   */
  applyRemoteState(id, { health, isAlive } = {}) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return null;

    if (Number.isFinite(health)) {
      const next = Math.max(0, health);
      // A drop in the authoritative health means a round just landed, so this
      // is where the character is told to flash. It is driven by the server's
      // own numbers rather than by our shot landing, which is what keeps a
      // whiffed shot from lighting the target up.
      if (next < rp.health) rp.hitFlash = Math.min(1, rp.hitFlash + (rp.health - next) / 40 + 0.35);
      rp.health = next;
    }
    if (typeof isAlive === 'boolean') {
      // An explicit isAlive always wins, but it is cross-checked against the
      // health value so a contradictory packet cannot resurrect a corpse or
      // bury a healthy player.
      rp.isAlive = isAlive && rp.health > this.DEATH_THRESHOLD;
    } else {
      rp.isAlive = rp.health > this.DEATH_THRESHOLD;
    }
    rp.dead = !rp.isAlive;

    // isAlive === true AND health > 0  =>  drawn
    // isAlive === false OR health <= 0 =>  hidden
    rp.mesh.visible = rp.isAlive && rp.health > this.DEATH_THRESHOLD;
    return rp;
  }

  /**
   * Asks the server to move us into a team slot.
   *
   * A request, not a command, and deliberately with no optimistic update: nothing
   * on screen moves until the server has validated the slot and broadcast the
   * roster. That is what makes a lost race harmless - the click simply redraws as
   * it was instead of showing a team the player is not in.
   *
   * @param {{team: 'blue'|'red', slot: number|null}} intent
   */
  selectTeam({ team, slot = null } = {}) {
    if (!this.socket || !this.connected) return;
    this.socket.emit('selectTeam', { team, slot }, (result) => {
      // The server answers with why it said no, so a refusal can be shown instead
      // of the click doing nothing at all.
      if (result && result.ok === false) {
        this.game.ui.showLobbyRefusal?.(result.reason || 'That slot is not available', this.socket.id);
      }
    });
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.clearRemotePlayers();
    this.game.scoreboard?.reset();
  }

  addRemotePlayer(playerInfo) {
    if (this.remotePlayers.has(playerInfo.id)) return;

    // The same blocky character the 1v1 duel opponent uses, and the same weapon
    // the player has actually selected - the server tracks `weaponIndex`, so an
    // opponent holding a pistol is holding a pistol, not the default rifle.
    // `createHeldWeapon` returns null until that model is loaded, and the
    // character keeps its premade rifle in that case.
    const { texture, imageData } = getBotSkin(REMOTE_SKIN);
    const weaponIndex = Number.isInteger(playerInfo.weaponIndex) ? playerInfo.weaponIndex : 0;
    const heldWeapon = createHeldWeapon(weaponIndex);
    const character = buildMinecraftCharacter({ texture, imageData, heldWeapon });

    // The character's origin is at its feet, so the root takes the reported
    // position as-is. The cylinder this replaced was modelled from its waist and
    // needed the extra 0.9 that the old interpolation applied.
    const bodyMesh = new THREE.Group();
    bodyMesh.name = `RemotePlayer-${playerInfo.id}`;
    bodyMesh.position.set(playerInfo.x, playerInfo.y, playerInfo.z);
    bodyMesh.add(character.group);

    // The parts a shot can land on, each tagged the way the projectile code
    // expects. Body and gun are kept apart so a weapon swap can replace the
    // gun's meshes without working out which of the current ones belong to the
    // body. The head is marked explicitly rather than inferred from a height
    // band, so headshots land on the head and nothing else.
    const bodyHitMeshes = [];
    const gunHitMeshes = [];
    character.hitMeshes.forEach((mesh) => {
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.userData = {
        isPlayer: true,
        id: playerInfo.id,
        head: mesh === character.head || mesh === character.headOverlay,
      };
      let onGun = false;
      mesh.traverseAncestors((ancestor) => {
        if (ancestor === character.gun) onGun = true;
      });
      (onGun ? gunHitMeshes : bodyHitMeshes).push(mesh);
    });

    this.game.arena.root.add(bodyMesh);

    const health = Number.isFinite(playerInfo.health) ? Math.max(0, playerInfo.health) : 100;
    const isAlive = playerInfo.isAlive !== undefined
      ? Boolean(playerInfo.isAlive)
      : !(playerInfo.dead === true || health <= 0);

    // Everything that is not part of the gun belongs to the body and is this
    // player's alone, so it is what gets freed on teardown.
    const bodyMaterials = character.materials.filter(
      (material) => !gunHitMeshes.some((mesh) => mesh.material === material),
    );

    this.remotePlayers.set(playerInfo.id, {
      id: playerInfo.id,
      mesh: bodyMesh,
      hitMeshes: [...bodyHitMeshes, ...gunHitMeshes],
      bodyHitMeshes,
      gunHitMeshes,
      head: character.head,
      headOverlay: character.headOverlay,
      torso: character.torso,
      leftArm: character.leftArm,
      rightArm: character.rightArm,
      leftLeg: character.leftLeg,
      rightLeg: character.rightLeg,
      gun: character.gun,
      gunHomeZ: character.gunHomeZ,
      heldWeapon,
      weaponIndex,
      skinMaterial: character.skinMaterial,
      overlayMaterial: character.overlayMaterial,
      gunMaterial: character.gunMaterial,
      materials: character.materials,
      bodyMaterials,
      walkPhase: Math.random() * Math.PI * 2,
      recoilKick: 0,
      hitFlash: 0,
      currentSpeed: 0,
      targetPosition: new THREE.Vector3(playerInfo.x, playerInfo.y, playerInfo.z),
      targetRotation: playerInfo.ry,
      health,
      isAlive: isAlive && health > this.DEATH_THRESHOLD,
      dead: !(isAlive && health > this.DEATH_THRESHOLD)
    });

    // Drawn whenever the authoritative state says alive - never because of a hit.
    bodyMesh.visible = health > this.DEATH_THRESHOLD && !(playerInfo.dead === true);

    console.log(`Added remote player ${playerInfo.id}`);
  }

  /**
   * Swaps the gun a remote character is holding, in place.
   *
   * The character is not rebuilt - only the contents of its gun group change.
   * The skin, the limb animation and the body's hit meshes are untouched, and
   * because the gun group is a stable node, recoil already in flight keeps
   * driving whatever gun is now in it.
   *
   * A model that has not finished loading leaves the current gun in place rather
   * than showing an empty hand.
   */
  setRemoteWeapon(id, weaponIndex) {
    const rp = this.remotePlayers.get(id);
    if (!rp) return;
    if (!Number.isInteger(weaponIndex) || weaponIndex === rp.weaponIndex) return;
    if (!HELD_WEAPONS[weaponIndex]) return;

    const held = createHeldWeapon(weaponIndex);
    if (!held) return;

    this.attachRemoteGun(rp, held, weaponIndex);
  }

  /** Replaces a remote player's gun and retags the meshes that came with it. */
  attachRemoteGun(rp, held, weaponIndex) {
    // Release what the old gun owned, then empty the group it lived in.
    disposeHeldWeapon(rp.heldWeapon);
    while (rp.gun.children.length) rp.gun.remove(rp.gun.children[0]);

    const gunMeshes = [];
    held.group.traverse((child) => {
      if (!child.isMesh) return;
      child.userData = { isPlayer: true, id: rp.id, head: false };
      gunMeshes.push(child);
    });

    rp.gun.add(held.group);
    rp.heldWeapon = held;
    rp.weaponIndex = weaponIndex;
    // A held model carries its grip anchor in a child group, so this one rests
    // at zero and recoil pushes off that.
    rp.gunHomeZ = 0;
    rp.gunMaterial = held.flashMaterial ?? rp.gunMaterial;
    rp.materials = [...rp.bodyMaterials, ...(held.materials ?? [])];
    rp.gunHitMeshes = gunMeshes;
    rp.hitMeshes = [...rp.bodyHitMeshes, ...gunMeshes];
  }

  /**
   * Puts a remote player back at their respawn point, alive and hit again.
   *
   * The character's origin is at its feet, so the reported position is applied
   * directly. The cylinder this replaced was modelled from its waist and needed
   * +0.9 here, which left the body standing half a metre off the floor.
   */
  respawnRemotePlayer(playerInfo) {
    if (!playerInfo || typeof playerInfo.id !== 'string') return;
    const rp = this.remotePlayers.get(playerInfo.id);
    if (rp) {
      // Authoritative revival. Snap them back in immediately so an alive
      // player is never left hidden.
      this.applyRemoteState(playerInfo.id, { health: 100, isAlive: true });
      rp.mesh.position.set(playerInfo.x, playerInfo.y, playerInfo.z);
      rp.targetPosition.set(playerInfo.x, playerInfo.y, playerInfo.z);
    }
    this.game.scoreboard?.setDead(playerInfo.id, false);
  }

  removeRemotePlayer(id) {
    const rp = this.remotePlayers.get(id);
    if (rp) {
      this.game.arena.root.remove(rp.mesh);
      // Only the body's own geometry. The weapon's geometry is shared with the
      // cached prototype that every player of that gun clones from, so disposing
      // it here would leave the gun broken for whoever joins next. The skin
      // texture is shared the same way and is likewise left alone.
      const gun = rp.gun;
      rp.mesh.traverse((child) => {
        if (!child.isMesh) return;
        let onGun = false;
        child.traverseAncestors((ancestor) => { if (ancestor === gun) onGun = true; });
        if (!onGun) child.geometry.dispose();
      });
      // The gun's own per-player materials, which are this player's alone.
      disposeHeldWeapon(rp.heldWeapon);
      (rp.bodyMaterials ?? []).forEach((material) => material.dispose());
      this.remotePlayers.delete(id);
      console.log(`Removed remote player ${id}`);
    }
  }

  clearRemotePlayers() {
    this.remotePlayers.forEach((rp, id) => {
      this.removeRemotePlayer(id);
    });
  }

  getHitMeshes() {
    // Every live remote player's individual meshes, for raycasting. Liveness
    // comes from the same flag that drives rendering, so a shot can never be
    // blocked by - or aimed at - a body whose visibility disagrees with its
    // health. Projectiles raycast non-recursively, so this has to hand back the
    // body parts and the gun rather than the group that holds them.
    const meshes = [];
    this.remotePlayers.forEach(rp => {
      if (rp.isAlive && rp.health > this.DEATH_THRESHOLD) {
        rp.mesh.updateMatrixWorld(true);
        meshes.push(...(rp.hitMeshes ?? [rp.mesh]));
      }
    });
    return meshes;
  }

  /**
   * Walks and shoots a remote character, using the same motion the duel bot
   * runs in EnemyAI.updateVisuals: leg swing scaled by speed, the right arm up
   * on the rifle, recoil driving the gun back and the torso, and the skin
   * flashing on a hit.
   *
   * Speed is derived from how far the interpolated root actually moved this
   * frame, so the walk keeps time with the movement the player can see rather
   * than with a timer that would drift against it.
   */
  animateRemotePlayer(rp, delta, travelled) {
    if (!rp.leftLeg) return;
    // Smoothed so a single dropped or late packet does not snap the legs.
    const instantSpeed = delta > 0 ? travelled / delta : 0;
    rp.currentSpeed += (instantSpeed - rp.currentSpeed) * Math.min(1, delta * 10);

    const walk = Math.min(rp.currentSpeed / 3.5, 1);
    rp.walkPhase += delta * (4.5 + rp.currentSpeed * 1.5);
    const swing = Math.sin(rp.walkPhase) * 0.52 * walk;

    rp.leftLeg.rotation.x = swing;
    rp.rightLeg.rotation.x = -swing;
    rp.leftArm.rotation.x = -0.08 - swing * 0.3;
    rp.rightArm.rotation.x = 0.85 + swing * 0.12;
    // Pushed back off the gun's own home, which is -0.42 for the premade rifle
    // and 0 for a real model carrying its grip anchor in a child group.
    rp.gun.position.z = rp.gunHomeZ + rp.recoilKick * 0.08;
    rp.torso.rotation.x = rp.recoilKick * 0.08;
    rp.recoilKick *= Math.exp(-10 * delta);
    rp.hitFlash *= Math.exp(-7.5 * delta);

    const flashAmount = Math.min(rp.hitFlash, 1);
    rp.skinMaterial.emissiveIntensity = flashAmount * 0.9;
    if (rp.overlayMaterial) rp.overlayMaterial.emissiveIntensity = flashAmount * 0.9;
    rp.gunMaterial.emissiveIntensity = flashAmount * 0.55;
  }

  update(delta, time) {
    if (!this.connected) return;

    // 1. Send our local position to the server periodically (Tick rate)
    if (time - this.lastTickTime > this.tickRate) {
      this.lastTickTime = time;
      
      const pos = this.game.player.root.position;
      const ry = this.game.camera.rotation.y; 
      
      this.socket.emit('playerMovement', {
        x: pos.x,
        y: pos.y,
        z: pos.z,
        rx: 0,
        ry: ry
      });
    }

    // 2. Smoothly interpolate remote players to their target positions
    this.remotePlayers.forEach(rp => {
      if (rp.dead) return;

      // Interpolate position (LERP). The character's origin is at its feet, so
      // this takes the reported position directly - no waist offset, which the
      // cylinder this replaced needed.
      const before = rp.mesh.position.distanceToSquared(rp.targetPosition);
      rp.mesh.position.lerp(rp.targetPosition, 15 * delta);
      const travelled = Math.sqrt(Math.max(0, before - rp.mesh.position.distanceToSquared(rp.targetPosition)));

      // Interpolate rotation smoothly
      const currentRot = rp.mesh.rotation.y;
      const targetRot = rp.targetRotation;

      // Fix shortest path wrapping
      let diff = targetRot - currentRot;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;

      rp.mesh.rotation.y += diff * 15 * delta;

      this.animateRemotePlayer(rp, delta, travelled);
    });

    // 3. Reconcile visibility against the authoritative liveness every frame.
    // This is the self-healing guard: whatever else happens, a player the
    // server still considers alive is drawn, and a player it considers dead is
    // not. Cheap, and it makes an alive player unable to get stuck invisible.
    this.remotePlayers.forEach((rp) => {
      const shouldBeVisible = rp.isAlive && rp.health > this.DEATH_THRESHOLD;
      if (rp.mesh.visible !== shouldBeVisible) rp.mesh.visible = shouldBeVisible;
    });

    // 4. Periodically re-pull the authoritative snapshot so both clients
    // converge on the same alive/dead verdict even if a packet was dropped.
    if (time - this.lastStateSyncTime > 2000) {
      this.lastStateSyncTime = time;
      this.socket.emit('requestPlayerState');
    }

    // 5. Hand out real guns to anyone who joined before theirs finished
    // downloading, or who picked one that had not arrived yet. The weapon index
    // is already known, so this only has to keep asking until the model is
    // there; a player already on a real gun has nothing to poll.
    this.remotePlayers.forEach((rp) => {
      if (rp.heldWeapon || !HELD_WEAPONS[rp.weaponIndex]) return;
      const held = createHeldWeapon(rp.weaponIndex);
      if (held) this.attachRemoteGun(rp, held, rp.weaponIndex);
    });
  }
  
  sendShot(origin, direction) {
    if (!this.connected) return;
    this.socket.emit('playerShot', {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z }
    });
  }

  /**
   * Tells the room which weapon is in our hands, so everyone else can put that
   * gun in our character's grip instead of leaving them holding the last one.
   */
  sendWeaponChanged(weaponIndex) {
    if (!this.connected) return;
    this.socket.emit('weaponChanged', weaponIndex);
  }
  
  sendHit(targetId, damage, headshot) {
    if (!this.connected) return;
    this.socket.emit('playerHit', {
      targetId: targetId,
      damage: damage,
      headshot: headshot
    });
  }
}
