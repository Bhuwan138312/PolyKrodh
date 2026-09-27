import * as THREE from 'three';
import { GAME_CONFIG } from '../config.js';
import { InputManager } from './InputManager.js';
import { AudioManager } from './AudioManager.js';
import { EffectPool } from './EffectPool.js';
import { ArenaMap } from '../world/ArenaMap.js';
import { NavigationGrid } from '../navigation/NavigationGrid.js';
import { PlayerController } from '../player/PlayerController.js';
import { WeaponSystem } from '../player/WeaponSystem.js';
import { BotSpawner } from '../enemies/BotSpawner.js';
import { UIManager } from '../ui/UIManager.js';
import { NetworkManager } from './NetworkManager.js';

export class Game {
  constructor(container) {
    this.container = container;
    this.clock = new THREE.Clock();
    this.elapsed = 0;
    this.state = 'LOADING';
    this.difficultyKey = 'normal';
    this.difficulty = GAME_CONFIG.difficulties.normal;
    this.kills = 0;
    this.outcome = null;
    this.outcomeTimer = 0;
    this.pointerLockPending = false;
    this.pointerLockWasActive = false;

    this.scene = new THREE.Scene();
    this.scene.background = new THREE.Color(0x1a1614); // Dark warehouse interior
    this.scene.fog = new THREE.Fog(0x1a1614, 20, 150);

    this.camera = new THREE.PerspectiveCamera(80, window.innerWidth / window.innerHeight, 0.045, 500);
    this.camera.rotation.order = 'YXZ';

    // Viewmodel fill light. The gun sits a few centimeters from the lens, so
    // it's extremely sensitive to whatever angle the world sun/fill happen to
    // be coming from — that's why it was reading dark/flat against a bright
    // background. A small light parented to the camera keeps it evenly lit
    // regardless of which way the player is facing.
    // Note: using DirectionalLight rather than PointLight on purpose — in
    // current three.js, PointLight/SpotLight intensity is in physical
    // candela units, where a value like 1.4 is nearly invisible. Directional
    // lights use the same simple unitless scale as the sun/fill above, so the
    // intensity here behaves predictably.
    this.viewmodelLight = new THREE.DirectionalLight(0xfff2d9, 1.2);
    this.viewmodelLight.position.set(0.3, 0.6, 0.4); // relative to camera, up and slightly behind
    this.viewmodelLightTarget = new THREE.Object3D();
    this.viewmodelLightTarget.position.set(0, -0.3, -1); // aim down-forward, where the gun sits
    this.viewmodelLight.target = this.viewmodelLightTarget;
    this.viewmodelLight.castShadow = false;
    this.camera.add(this.viewmodelLight);
    this.camera.add(this.viewmodelLightTarget);
    this.scene.add(this.camera); // camera must be in the scene graph for its children to render
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFShadowMap;
    this.applyGraphicsQuality(localStorage.getItem('graphicsQuality') || 'high');
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.domElement.id = 'game-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'PolyKrodh 3D arena');
    container.querySelector('#viewport').appendChild(this.renderer.domElement);

    this.audio = new AudioManager();
    this.effects = new EffectPool(this.scene);
    this.arena = new ArenaMap(this.scene);
    this.navigation = new NavigationGrid(this.arena);
    this.input = new InputManager(this.renderer.domElement);

    // Global debug toggle for collision (Capsule + map triangles)
    window.DEBUG_COLLISION = false;
    window.toggleCollisionDebug = () => {
      window.DEBUG_COLLISION = !window.DEBUG_COLLISION;
      console.log('Collision Debug:', window.DEBUG_COLLISION);

      if (window.DEBUG_COLLISION) {
        if (!this.arena.debugWireframes) {
          this.arena.debugWireframes = new THREE.Group();
          this.scene.add(this.arena.debugWireframes);
          for (const mesh of this.arena.modelMeshes || []) {
            const wire = new THREE.Mesh(mesh.geometry, new THREE.MeshBasicMaterial({ color: 0x00ff00, wireframe: true, transparent: true, opacity: 0.3, depthTest: false }));
            mesh.getWorldPosition(wire.position);
            mesh.getWorldQuaternion(wire.quaternion);
            mesh.getWorldScale(wire.scale);
            this.arena.debugWireframes.add(wire);
          }
        }
        this.arena.debugWireframes.visible = true;
      } else if (this.arena.debugWireframes) {
        this.arena.debugWireframes.visible = false;
      }
    };
    this.player = new PlayerController({
      scene: this.scene,
      camera: this.camera,
      input: this.input,
      arena: this.arena,
      audio: this.audio,
    });

    this.player.onHealthChanged = (health) => this.ui.setHealth(health, this.player.health.maxHealth);
    this.player.onDeath = () => this.queueOutcome(false);
    const createWeaponCallbacks = (getWeapon) => ({
      getBotHitMeshes: () => {
        const bots = this.spawner.getHitMeshes();
        const players = this.isMultiplayer && this.network ? this.network.getHitMeshes() : [];
        return [...bots, ...players];
      },
      onBotHit: (bot, damage, point, headshot) => this.handleBotHit(bot, damage, point, headshot),
      onPlayerHit: (id, damage, headshot) => {
        if (this.isMultiplayer && this.network) this.network.sendHit(id, damage, headshot);
      },
      onFired: (origin, direction) => {
        if (this.isMultiplayer && this.network) this.network.sendShot(origin, direction);
      },
      onAmmoChange: (magazine, reserve, reloading, elapsed) => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(magazine, reserve, reloading, elapsed, getWeapon().config);
      },
      onSpread: (spread) => {
        if (this.activeWeapon === getWeapon()) this.ui.setSpread(spread);
      },
      onReloadStart: () => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(getWeapon().magazine, getWeapon().reserve, true, 0, getWeapon().config);
      },
      onReloadProgress: (magazine, reserve, elapsed) => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(magazine, reserve, true, elapsed, getWeapon().config);
      },
      onReloadEnd: () => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(getWeapon().magazine, getWeapon().reserve, false, 0, getWeapon().config);
      },
      onDry: () => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(getWeapon().magazine, getWeapon().reserve, false, 0, getWeapon().config);
      },
    });

    this.primaryWeapon = new WeaponSystem({
      scene: this.scene, camera: this.camera, player: this.player, arena: this.arena, effects: this.effects, audio: this.audio,
      config: GAME_CONFIG.weapon, modelUrl: '/models/m416rifle.glb?v=3', displayName: 'M416', targetLength: 1.15, viewScale: 1.15,
      basePosition: new THREE.Vector3(0.18, -0.37, -0.35), // Same placement as before
      modelOffset: new THREE.Vector3(0, 0, 0), // Reset offset so it doesn't stick out forward
      callbacks: createWeaponCallbacks(() => this.primaryWeapon),
    });

    this.secondaryWeapon = new WeaponSystem({
      scene: this.scene, camera: this.camera, player: this.player, arena: this.arena, effects: this.effects, audio: this.audio,
      config: GAME_CONFIG.secondaryWeapon, modelUrl: '/models/Pistol.glb', displayName: 'Pistol', targetLength: 0.42, viewScale: 1.0,
      basePosition: new THREE.Vector3(0.18, -0.37, -0.35), // Same placement as M4
      callbacks: createWeaponCallbacks(() => this.secondaryWeapon),
    });

    this.weapons = [this.primaryWeapon, this.secondaryWeapon];
    this.activeWeaponIndex = 0;
    this.activeWeapon = this.primaryWeapon;
    this.player.weapon = this.activeWeapon;
    this.secondaryWeapon.model.visible = false;
    this.primaryWeapon.model.visible = false;

    this.input.onDigit1 = () => this.switchWeapon(0);
    this.input.onDigit2 = () => this.switchWeapon(1);
    this.input.onKeyE = () => {
      if (this.activeWeapon?.toggleSuppressor) {
        this.activeWeapon.toggleSuppressor();
      }
    };
    this.input.onKeyQ = () => {
      if (this.activeWeapon?.toggleAltView) {
        this.activeWeapon.toggleAltView();
      }
    };
    this.input.onScrollUp = () => this.switchWeapon((this.activeWeaponIndex + 1) % this.weapons.length);
    this.input.onScrollDown = () => this.switchWeapon((this.activeWeaponIndex - 1 + this.weapons.length) % this.weapons.length);

    // Weapon switch animation state
    this.weaponSwitching = false;
    this.switchElapsed = 0;
    this.switchDuration = 0.3;        // total switch time
    this.switchHalfTime = 0.15;       // halfway point: old weapon fully down
    this.switchTargetIndex = -1;
    this.switchPhase = 'none';        // 'down', 'up', 'none'
    this.switchOffsetY = 0;           // vertical offset applied to weapon holder

    this.spawner = new BotSpawner({
      scene: this.scene,
      arena: this.arena,
      navigation: this.navigation,
      effects: this.effects,
      audio: this.audio,
      onDeath: (bot) => this.handleBotDeath(bot),
    });

    this.network = new NetworkManager(this);

    this.ui = new UIManager({ audio: this.audio, weaponConfig: GAME_CONFIG.weapon });
    this.ui.setCallbacks({
      startMatch: (difficulty, map) => this.startMatch(difficulty, map, false),
      hostMatch: (roomName, password) => {
        if (roomName) {
          this.isMultiplayer = true;
          const serverPort = window.location.port === '5173' ? ':3001' : (window.location.port ? ':' + window.location.port : '');
          const address = `${window.location.protocol}//${window.location.hostname}${serverPort}`;
          this.network.connect(address, roomName, password);
        }
      },
      joinMatch: (roomName, password) => {
        if (roomName) {
          this.isMultiplayer = true;
          const serverPort = window.location.port === '5173' ? ':3001' : (window.location.port ? ':' + window.location.port : '');
          const address = `${window.location.protocol}//${window.location.hostname}${serverPort}`;
          this.network.connect(address, roomName, password);
        }
      },
      startGame: () => {
        if (this.network && this.network.socket) {
          this.network.socket.emit('startGame', this.ui.map);
        }
      },
      leaveLobby: () => {
        if (this.network) this.network.disconnect();
        this.isMultiplayer = false;
        this.ui.show('menu');
      },
      resume: () => this.resume(),
      restart: () => {
        if (this.isMultiplayer) {
          this.ui.show('lobby');
        } else {
          this.startMatch(this.difficultyKey, this.currentMapName);
        }
      },
      showMenu: () => this.showMenu(),
      quit: () => this.quit(),
      setSensitivity: (value) => this.input.setSensitivity(value),
      setInvertY: (invert) => this.input.setInvertY(invert),
      setBinding: (action, code) => this.input.setBinding(action, code),
      setGraphicsQuality: (val) => this.applyGraphicsQuality(val)
    });

    this.input.onEscape = () => {
      if (this.state === 'PLAYING' && !this.outcome) this.pause();
    };
    this.input.onPointerLockChange = (locked) => this.handlePointerLock(locked);
    this.input.onPointerLockError = () => this.handlePointerLockError();
    this.input.onBlur = () => {
      if (this.state === 'PLAYING' && !this.outcome) this.pause();
    };
    this.input.onAnyInteraction = () => this.audio.resume();

    window.addEventListener('resize', () => this.resize());
    document.addEventListener('visibilitychange', () => {
      if (document.hidden && this.state === 'PLAYING' && !this.outcome) this.pause();
    });

    this.player.reset(this.arena.getPlayerSpawn());
    this.ui.setHealth(this.player.health.current, this.player.health.maxHealth);
    this.ui.setAmmo(this.activeWeapon.magazine, this.activeWeapon.reserve, false, 0, this.activeWeapon.config);
    this.ui.setEnemies(0);
    this.bindLoop();
  }

  updateEnvironment(mapName) {
    if (mapName === 'smalltdm') {
      this.scene.background = new THREE.Color(0x1a1614);
      this.scene.fog = new THREE.Fog(0x1a1614, 20, 150);
    } else {
      this.scene.background = new THREE.Color(0xaed4f5); // Default daylight sky
      this.scene.fog = new THREE.Fog(0xaed4f5, 120, 350);
    }
  }

  async init() {
    await this.arena.loadMapModel('arena');
    this.navigation.build(this.arena);
    this.currentMapName = 'arena';
    this.updateEnvironment('arena');

    await Promise.all([this.primaryWeapon.ready, this.secondaryWeapon.ready]);
    requestAnimationFrame(() => {
      if (this.state === 'LOADING') {
        this.showMenu();
        this.ui.finishLoading();
      }
    });
  }

  async startMatch(difficultyKey = 'normal', mapName = 'arena', isMultiplayer = false, isHost = false, roomName = 'Lobby') {
    this.audio.resume();
    this.difficultyKey = difficultyKey in GAME_CONFIG.difficulties ? difficultyKey : 'normal';
    this.difficulty = GAME_CONFIG.difficulties[this.difficultyKey];
    this.isMultiplayer = isMultiplayer;

    this.ui.screens.loading.classList.remove('is-hidden');

    // Yield to the browser so the loading screen actually renders before we freeze the main thread
    await new Promise(resolve => setTimeout(resolve, 50));

    if (this.currentMapName !== mapName) {
      await this.arena.loadMapModel(mapName);
      this.navigation.build();
      this.currentMapName = mapName;
      this.updateEnvironment(mapName);
    }

    if (!this.isMultiplayer) {
      this.network.disconnect();
    }

    this.kills = 0;
    this.outcome = null;
    this.outcomeTimer = 0;
    this.effects.clear();
    this.ui.resetMatchHud();
    this.arena.setDynamicActors([]);
    this.player.reset(this.arena.getPlayerSpawn());
    this.activeWeaponIndex = 0;
    this.activeWeapon = this.primaryWeapon;
    this.player.weapon = this.activeWeapon;
    this.weapons.forEach(w => {
      w.clearTransientEffects();
      w.model.visible = false;
      w.reset();
    });
    this.activeWeapon.model.visible = true;

    if (!this.isMultiplayer) {
      this.spawner.spawnMatch(this.player.root.position, this.difficulty);
    } else {
      this.spawner.clear();
    }

    this.updateDynamicActors();
    this.ui.setHealth(this.player.health.current, this.player.health.maxHealth);
    this.ui.setAmmo(this.activeWeapon.magazine, this.activeWeapon.reserve, false, 0, this.activeWeapon.config);

    if (this.isMultiplayer) {
      this.ui.enemiesValue.parentElement.style.display = 'none'; // Hide hostiles counter in PvP
    } else {
      this.ui.enemiesValue.parentElement.style.display = 'flex';
      this.ui.setEnemies(this.spawner.getAlive());
    }
    this.ui.setActiveWeaponIcon(this.activeWeaponIndex, this.activeWeapon.displayName);
    this.ui.showHud();

    // Disable dynamic shadows and force a single exact render pass to bake them!
    this.renderer.shadowMap.autoUpdate = false;
    this.renderer.shadowMap.needsUpdate = true;
    this.renderer.compile(this.scene, this.camera);
    this.renderer.render(this.scene, this.camera);

    this.ui.screens.loading.classList.add('is-hidden');

    this.state = 'PLAYING';
    this.input.clear();
    this.input.setEnabled(true);
    this.requestPlayablePointerLock();
  }

  switchWeapon(index) {
    if (this.state !== 'PLAYING' || this.outcome || index === this.activeWeaponIndex || index < 0 || index >= this.weapons.length) return;
    if (this.weaponSwitching) return; // Already switching
    if (this.activeWeapon.reloading) return; // Can't switch during reload

    this.weaponSwitching = true;
    this.switchElapsed = 0;
    this.switchTargetIndex = index;
    this.switchPhase = 'down';
    this.switchOffsetY = 0;
  }

  updateWeaponSwitch(delta) {
    if (!this.weaponSwitching) return;

    this.switchElapsed += delta;

    if (this.switchPhase === 'down') {
      // Dropping old weapon down
      const t = Math.min(this.switchElapsed / this.switchHalfTime, 1);
      const eased = t * t; // ease-in: accelerate down
      this.switchOffsetY = -eased * 0.45;

      if (t >= 1) {
        // Halfway: swap the actual weapon
        this.activeWeapon.model.visible = false;
        this.activeWeaponIndex = this.switchTargetIndex;
        this.activeWeapon = this.weapons[this.switchTargetIndex];
        this.player.weapon = this.activeWeapon;
        this.activeWeapon.model.visible = true;
        this.ui.setAmmo(this.activeWeapon.magazine, this.activeWeapon.reserve, this.activeWeapon.reloading, this.activeWeapon.reloadElapsed, this.activeWeapon.config);
        this.ui.setActiveWeaponIcon(this.activeWeaponIndex, this.activeWeapon.displayName);

        this.switchPhase = 'up';
        this.switchElapsed = 0;
        this.switchOffsetY = -0.45;
      }
    } else if (this.switchPhase === 'up') {
      // Bringing new weapon up
      const t = Math.min(this.switchElapsed / this.switchHalfTime, 1);
      const eased = 1 - (1 - t) * (1 - t); // ease-out: decelerate as it arrives
      this.switchOffsetY = -0.45 * (1 - eased);

      if (t >= 1) {
        this.weaponSwitching = false;
        this.switchPhase = 'none';
        this.switchOffsetY = 0;
      }
    }

    // Apply offset to the active weapon holder
    this.activeWeapon.weaponHolder.position.y += this.switchOffsetY;
  }

  requestPlayablePointerLock() {
    if (this.state !== 'PLAYING' || this.outcome) return;
    clearTimeout(this.pointerLockTimeout);
    this.pointerLockPending = true;
    this.ui.setCaptureHint(true);
    this.input.requestPointerLock();
    this.pointerLockTimeout = setTimeout(() => {
      if (this.state === 'PLAYING' && this.pointerLockPending && document.pointerLockElement !== this.renderer.domElement) {
        this.pointerLockPending = false;
        this.pause();
      }
    }, 1200);
  }

  pause() {
    if (this.state !== 'PLAYING' || this.outcome) return;
    this.state = 'PAUSED';
    clearTimeout(this.pointerLockTimeout);
    this.pointerLockPending = false;
    this.pointerLockWasActive = false;
    this.input.setEnabled(false);
    this.input.releasePointerLock();
    this.ui.setCaptureHint(false);
    this.ui.setADS(0);
    this.ui.show('pause');
  }

  resume() {
    if (this.state !== 'PAUSED') return;
    this.audio.resume();
    this.state = 'PLAYING';
    this.ui.showHud();
    this.input.clear();
    this.input.setEnabled(true);
    this.requestPlayablePointerLock();
  }

  showMenu() {
    this.state = 'MENU';
    this.outcome = null;
    clearTimeout(this.pointerLockTimeout);
    this.pointerLockPending = false;
    this.pointerLockWasActive = false;
    this.input.setEnabled(false);
    this.input.releasePointerLock();
    this.spawner.clear();
    this.arena.setDynamicActors([]);
    this.effects.clear();
    this.weapons.forEach(w => w.clearTransientEffects());
    this.ui.resetMatchHud();
    this.weapons.forEach(w => w.model.visible = false);
    this.player.root.position.set(34, 9, 34);
    this.camera.fov = 56;
    this.camera.updateProjectionMatrix();
    this.ui.setCaptureHint(false);
    this.ui.show('menu');
  }

  quit() {
    this.state = 'QUIT';
    this.outcome = null;
    clearTimeout(this.pointerLockTimeout);
    this.pointerLockPending = false;
    this.pointerLockWasActive = false;
    this.input.setEnabled(false);
    this.input.releasePointerLock();
    this.spawner.clear();
    this.arena.setDynamicActors([]);
    this.effects.clear();
    this.weapons.forEach(w => w.clearTransientEffects());
    this.ui.resetMatchHud();
    this.weapons.forEach(w => w.model.visible = false);
    this.ui.setCaptureHint(false);
    this.ui.show('quit');
  }

  handlePointerLock(locked) {
    if (locked) {
      clearTimeout(this.pointerLockTimeout);
      this.pointerLockPending = false;
      this.pointerLockWasActive = true;
      if (this.state === 'PLAYING' && !this.outcome) {
        this.ui.setCaptureHint(false);
      } else {
        this.pointerLockWasActive = false;
        this.input.releasePointerLock();
      }
      return;
    }

    this.pointerLockPending = false;
    this.pointerLockWasActive = false;
    if (this.state === 'PLAYING' && this.input.enabled && !this.outcome) {
      this.pause();
    }
  }

  handlePointerLockError() {
    clearTimeout(this.pointerLockTimeout);
    this.pointerLockPending = false;
    this.pointerLockWasActive = false;
    if (this.state === 'PLAYING') {
      this.ui.setCaptureHint(true);
    } else {
      this.ui.setCaptureHint(false);
    }
  }

  handleBotHit(bot, damage, point, headshot) {
    const killed = bot.takeDamage(
      damage,
      point,
      headshot,
      this.player.root.position,
      { player: this.player, elapsed: this.elapsed },
    );
    this.ui.showHitMarker(headshot);
    if (!killed) this.audio.play(headshot ? 'headshot' : 'hit', bot.root.position);
  }

  handleBotDeath(bot) {
    this.kills += 1;
    this.ui.announceKill(bot.type.name);
    this.ui.setEnemies(this.spawner.getAlive());
    if (this.spawner.getAlive() === 0) this.queueOutcome(true);
  }

  queueOutcome(won) {
    if (this.outcome !== null) return;
    this.outcome = won ? 'victory' : 'defeat';
    this.outcomeTimer = won ? 0.82 : 0.68;
    this.pointerLockPending = false;
    this.pointerLockWasActive = false;
    this.input.setEnabled(false);
    this.input.releasePointerLock();
    this.ui.setCaptureHint(false);
  }

  playerDiedLocally(killerId) {
    if (this.outcome !== null) return;
    this.player.health.current = 0;
    
    if (this.isMultiplayer) {
      this.ui.announceKill('You were killed!');
      // Wait 3 seconds, then respawn
      setTimeout(() => {
        if (this.state !== 'PLAYING') return;
        // Find killer's position to avoid spawning near them
        let avoidPosition = null;
        if (killerId && this.network && this.network.remotePlayers.has(killerId)) {
          avoidPosition = this.network.remotePlayers.get(killerId).mesh.position;
        }
        const newSpawn = this.arena.getPlayerSpawn(avoidPosition);
        this.player.reset(newSpawn);
        if (this.network && this.network.socket) {
           this.network.socket.emit('respawn', { x: newSpawn.x, y: newSpawn.y, z: newSpawn.z });
        }
      }, 3000);
    } else {
      this.queueOutcome(false);
    }
  }

  finishOutcome() {
    const won = this.outcome === 'victory';
    this.state = won ? 'WON' : 'LOST';
    this.ui.showEnd(won, this.kills, this.difficulty.count, this.player.health.current);
    this.audio.play(won ? 'victory' : 'defeat');
  }

  finishMultiplayerMatch(winnerId, stats) {
    this.state = 'WON'; // Just an end state
    this.ui.showMultiplayerEnd(winnerId, stats, this.network.socket.id);
    this.audio.play(winnerId === this.network.socket.id ? 'victory' : 'defeat');
  }

  updateMenuCamera(delta) {
    const angle = this.elapsed * 0.035 + 0.8;
    const radius = 39;
    this.player.root.position.set(Math.cos(angle) * radius, 10.5, Math.sin(angle) * radius);
    this.player.root.rotation.y = 0;
    this.camera.position.set(0, 4.2, 0);
    this.camera.fov = THREE.MathUtils.lerp(this.camera.fov, 56, 1 - Math.exp(-3 * delta));
    this.camera.updateProjectionMatrix();
    this.player.root.updateMatrixWorld(true);
    this.camera.lookAt(0, 1.8, 0);
  }

  updateDynamicActors() {
    const actors = [{
      owner: this.player,
      position: this.player.root.position,
      radius: this.player.config.radius,
      height: this.player.config.height,
    }];
    for (const bot of this.spawner.bots) {
      if (bot.dead || bot.removed) continue;
      actors.push({ owner: bot, position: bot.root.position, radius: 0.43, height: 1.85 });
    }
    this.arena.setDynamicActors(actors);
  }

  updateMatch(delta) {
    this.updateDynamicActors();
    if (!this.outcome) {
      // Drop ADS during reload or weapon switch
      this.player.forceNoAds = this.activeWeapon.reloading || this.weaponSwitching;
      this.player.updateAimState(delta);
      const look = this.input.consumeMouseDelta();
      this.player.look(look.x, look.y);
      this.player.update(delta, true);
      if (this.outcome) return;
      this.activeWeapon.update(delta);
      if (this.outcome) return;
      this.updateWeaponSwitch(delta);
      this.spawner.update(delta, { player: this.player, elapsed: this.elapsed });
      this.activeWeapon.updateTransientEffects(delta);
      this.ui.setADS(this.player.adsAmount);
      this.ui.setMoveState(this.player.adsActive ? 'AIM' : this.player.sprinting && this.player.currentSpeed > 4.5 ? 'SPRINT' : this.player.grounded ? 'READY' : 'AIRBORNE');
    } else {
      this.outcomeTimer -= delta;
      for (const bot of this.spawner.bots) {
        if (bot.dead && !bot.removed) bot.update(delta, { player: this.player, elapsed: this.elapsed });
      }
      if (this.spawner.bots.some((bot) => bot.removed)) {
        this.spawner.bots = this.spawner.bots.filter((bot) => !bot.removed);
      }
      if (this.outcomeTimer <= 0) this.finishOutcome();
    }
    this.ui.setDamageFlash(this.player.damageFlash);
  }

  resize() {
    this.camera.aspect = window.innerWidth / window.innerHeight;
    this.camera.updateProjectionMatrix();
    // Do not override user's pixel ratio setting on resize
    this.renderer.setSize(window.innerWidth, window.innerHeight);
  }

  applyGraphicsQuality(quality) {
    switch (quality) {
      case 'low':
        this.renderer.setPixelRatio(0.75);
        this.renderer.shadowMap.enabled = false;
        break;
      case 'medium':
        this.renderer.setPixelRatio(1.0);
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.BasicShadowMap;
        break;
      case 'high':
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.25));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        break;
      case 'ultra':
        this.renderer.setPixelRatio(Math.max(window.devicePixelRatio, 1.5));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        break;
    }

    this.scene.traverse((child) => {
      if (child.isMesh && child.material) {
        if (Array.isArray(child.material)) {
          child.material.forEach(m => m.needsUpdate = true);
        } else {
          child.material.needsUpdate = true;
        }
      }
    });
  }

  bindLoop() {
    const frame = () => {
      const rawDelta = this.clock.getDelta();
      const delta = Math.min(rawDelta, 0.04);
      this.elapsed += delta;

      if (this.state === 'MENU' || this.state === 'QUIT') this.updateMenuCamera(delta);
      if (this.state === 'PLAYING') this.updateMatch(delta);

      this.arena.update(delta, this.elapsed);
      if (this.network) this.network.update(delta, this.elapsed * 1000);

      this.effects.update(delta);
      this.audio.updateListener(this.camera);
      this.input.endFrame();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}