import { io } from 'socket.io-client';
import * as THREE from 'three';

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
    });

    this.socket.on('roomStatus', (data) => {
      this.hostId = data.host;
      if (data.status === 'playing' && !this.matchStarted) {
        this.matchStarted = true;
        this.game.startMatch('normal', data.map || 'arena', true, false, roomName, true);
      }
      if (!this.matchStarted) this.updateLobbyUI();
    });

    this.socket.on('matchStarted', (mapName) => {
      this.matchStarted = true;
      this.game.startMatch('normal', mapName || 'arena', true, false, roomName, true);
    });

    // When we first join, server sends us everyone already in the game
    this.socket.on('currentPlayers', (players) => {
      this.lobbyPlayers = players;
      if (!this.matchStarted) this.updateLobbyUI();

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
    });

    // When a new player joins while we are already in
    this.socket.on('newPlayer', (playerInfo) => {
      this.lobbyPlayers[playerInfo.id] = playerInfo;
      if (!this.matchStarted) this.updateLobbyUI();
      this.addRemotePlayer(playerInfo);
    });

    // When someone leaves
    this.socket.on('playerDisconnected', (id) => {
      delete this.lobbyPlayers[id];
      if (!this.matchStarted) this.updateLobbyUI();
      this.removeRemotePlayer(id);
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
      }
    });

    // When someone dies
    this.socket.on('playerDied', (data) => {
      if (!data || typeof data.victimId !== 'string') return;
      if (data.victimId === this.socket.id) {
        // We died! The server already decided this, so our own health adopts
        // the authoritative 0 rather than inferring it from a hit.
        this.game.playerDiedLocally(data.killerId);
      } else {
        // Someone else died. Authoritative death, so hide them.
        const rp = this.remotePlayers.get(data.victimId);
        if (rp) {
          this.applyRemoteState(data.victimId, { health: 0, isAlive: false });
          this.game.ui.announceKill('Player ' + data.victimId.substring(0, 4));
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
    });

    this.socket.on('matchFinished', (data) => {
      this.matchStarted = false;
      this.game.finishMultiplayerMatch(data.winner, data.stats);
    });

    // When someone respawns
    this.socket.on('playerRespawned', (playerInfo) => {
      if (!playerInfo || typeof playerInfo.id !== 'string') return;
      const rp = this.remotePlayers.get(playerInfo.id);
      if (rp) {
        // Authoritative revival. Snap them back in immediately so an alive
        // player is never left hidden.
        this.applyRemoteState(playerInfo.id, { health: 100, isAlive: true });
        rp.mesh.position.set(playerInfo.x, playerInfo.y + 0.9, playerInfo.z);
        rp.targetPosition.set(playerInfo.x, playerInfo.y, playerInfo.z);
      }
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

    if (Number.isFinite(health)) rp.health = Math.max(0, health);
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

  updateLobbyUI() {
    this.game.ui.updateLobbyPlayers(this.lobbyPlayers, this.hostId, this.socket.id);
  }

  disconnect() {
    if (this.socket) {
      this.socket.disconnect();
      this.socket = null;
    }
    this.connected = false;
    this.clearRemotePlayers();
  }

  addRemotePlayer(playerInfo) {
    if (this.remotePlayers.has(playerInfo.id)) return;

    // Create a simple mesh to represent the remote player (Placeholder for now)
    const material = new THREE.MeshStandardMaterial({ color: 0x438ce2, roughness: 0.8 });
    const bodyGeometry = new THREE.CylinderGeometry(0.4, 0.4, 1.8, 16);
    const bodyMesh = new THREE.Mesh(bodyGeometry, material);
    bodyMesh.position.set(playerInfo.x, playerInfo.y + 0.9, playerInfo.z);
    bodyMesh.castShadow = true;
    bodyMesh.receiveShadow = true;

    // Add a simple head/visor to show which way they are facing
    const visorMaterial = new THREE.MeshStandardMaterial({ color: 0x111111, roughness: 0.1 });
    const visor = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.2, 0.4), visorMaterial);
    visor.position.set(0, 0.6, -0.3); // Forward is -Z in Three.js
    bodyMesh.add(visor);
    
    // Add hitbox reference for raycasting
    bodyMesh.userData = { isPlayer: true, id: playerInfo.id };

    this.game.arena.root.add(bodyMesh);

    const health = Number.isFinite(playerInfo.health) ? Math.max(0, playerInfo.health) : 100;
    const isAlive = playerInfo.isAlive !== undefined
      ? Boolean(playerInfo.isAlive)
      : !(playerInfo.dead === true || health <= 0);

    this.remotePlayers.set(playerInfo.id, {
      id: playerInfo.id,
      mesh: bodyMesh,
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

  removeRemotePlayer(id) {
    const rp = this.remotePlayers.get(id);
    if (rp) {
      this.game.arena.root.remove(rp.mesh);
      rp.mesh.geometry.dispose();
      rp.mesh.material.dispose();
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
    // Return all live remote player meshes for raycasting. Liveness comes from
    // the same flag that drives rendering, so a shot can never be blocked by -
    // or aimed at - a cylinder whose visibility disagrees with its health.
    const meshes = [];
    this.remotePlayers.forEach(rp => {
      if (rp.isAlive && rp.health > this.DEATH_THRESHOLD) {
        rp.mesh.updateMatrixWorld(true);
        meshes.push(rp.mesh);
      }
    });
    return meshes;
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
      
      // Interpolate position (LERP)
      rp.mesh.position.lerp(new THREE.Vector3(rp.targetPosition.x, rp.targetPosition.y + 0.9, rp.targetPosition.z), 15 * delta);
      
      // Interpolate rotation smoothly
      const currentRot = rp.mesh.rotation.y;
      const targetRot = rp.targetRotation;
      
      // Fix shortest path wrapping
      let diff = targetRot - currentRot;
      while (diff < -Math.PI) diff += Math.PI * 2;
      while (diff > Math.PI) diff -= Math.PI * 2;
      
      rp.mesh.rotation.y += diff * 15 * delta;
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
  }
  
  sendShot(origin, direction) {
    if (!this.connected) return;
    this.socket.emit('playerShot', {
      origin: { x: origin.x, y: origin.y, z: origin.z },
      direction: { x: direction.x, y: direction.y, z: direction.z }
    });
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
