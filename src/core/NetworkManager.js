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
  }

  connect(serverAddress, roomName = 'Lobby', password = '') {
    const address = serverAddress || `http://${window.location.hostname}:3001`;
    
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
        this.game.startMatch('normal', 'arena', true, false, roomName, true); // true at the end to signify match started
      }
      if (!this.matchStarted) this.updateLobbyUI();
    });

    this.socket.on('matchStarted', () => {
      this.matchStarted = true;
      this.game.startMatch('normal', 'arena', true, false, roomName, true);
    });

    // When we first join, server sends us everyone already in the game
    this.socket.on('currentPlayers', (players) => {
      this.lobbyPlayers = players;
      if (!this.matchStarted) this.updateLobbyUI();

      Object.keys(players).forEach(id => {
        if (id === this.socket.id) return; // Don't add ourselves
        this.addRemotePlayer(players[id]);
      });
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
      const rp = this.remotePlayers.get(playerInfo.id);
      if (rp && this.matchStarted) {
        // We'll interpolate towards this position in the update loop
        rp.targetPosition.set(playerInfo.x, playerInfo.y, playerInfo.z);
        rp.targetRotation = playerInfo.ry;
      }
    });

    // When someone shoots
    this.socket.on('playerFired', (shotData) => {
      // Find the remote player
      const rp = this.remotePlayers.get(shotData.id);
      if (rp) {
        // Recreate the bullet tracer and gunshot sound from their location
        const origin = new THREE.Vector3(shotData.origin.x, shotData.origin.y, shotData.origin.z);
        const direction = new THREE.Vector3(shotData.direction.x, shotData.direction.y, shotData.direction.z);
        
        // Play gunshot sound at their location
        this.game.audio.play('assault_fire', origin);
        
        // Draw the tracer
        const target = origin.clone().add(direction.clone().multiplyScalar(50));
        this.game.effects.addTracer(origin, target);
        this.game.effects.addMuzzleFlash(origin, rp.mesh);
      }
    });

    // When someone dies
    this.socket.on('playerDied', (data) => {
      if (data.victimId === this.socket.id) {
        // We died!
        this.game.playerDiedLocally(data.killerId);
      } else {
        // Someone else died
        const rp = this.remotePlayers.get(data.victimId);
        if (rp) {
          rp.dead = true;
          rp.mesh.visible = false; // Hide them for now
          this.game.ui.announceKill('Player ' + data.victimId.substring(0, 4));
        }
      }
    });

    // When someone respawns
    this.socket.on('playerRespawned', (playerInfo) => {
      const rp = this.remotePlayers.get(playerInfo.id);
      if (rp) {
        rp.dead = false;
        rp.mesh.visible = true;
        rp.mesh.position.set(playerInfo.x, playerInfo.y + 0.9, playerInfo.z);
        rp.targetPosition.set(playerInfo.x, playerInfo.y, playerInfo.z);
      }
    });

    // When we take damage from someone else
    this.socket.on('takeDamage', (data) => {
      this.game.player.health.damage(data.damage);
      // Play local damage effects
      this.game.effects.damageVignette();
      this.game.audio.play('hit_player');
    });
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

    this.remotePlayers.set(playerInfo.id, {
      id: playerInfo.id,
      mesh: bodyMesh,
      targetPosition: new THREE.Vector3(playerInfo.x, playerInfo.y, playerInfo.z),
      targetRotation: playerInfo.ry,
      dead: playerInfo.dead
    });
    
    if (playerInfo.dead) {
      bodyMesh.visible = false;
    }
    
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
    // Return all remote player meshes for raycasting
    const meshes = [];
    this.remotePlayers.forEach(rp => {
      if (!rp.dead) {
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
