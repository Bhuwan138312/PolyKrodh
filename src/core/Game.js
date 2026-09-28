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
import { Scoreboard } from '../ui/Scoreboard.js';
import { NetworkManager } from './NetworkManager.js';

// How long the solo death cam holds on the killer before the round respawns.
const DEATH_CAM_SECONDS = 2.6;

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
    // Multiplayer respawn countdown state (see playerDiedLocally).
    this.respawnPending = false;
    this.respawnTimer = 0;
    this.respawnKillerId = null;
    // Solo 1v1 duel state: a death cam that focuses the killer before the
    // respawn, plus the bot respawn that starts the next round.
    this.deathCam = null;
    this.botRespawnTimer = 0;
    this.botRespawnPending = null;
    this.soloDeathHandling = false;
    this.duelKills = 0;
    this.duelDeaths = 0;
    this.duelBotKills = 0;
    this.duelBotDeaths = 0;
    this.LOCAL_ME = 'you';

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
    // In PvP the server is the only thing allowed to decide we died, so the
    // local health running out must not fire the solo defeat/outcome flow.
    // Solo death routes through playerDiedLocally so the 1v1 duel can show its
    // death cam instead of ending the match.
    this.player.onDeath = () => {
      if (this.isMultiplayer) return;
      this.playerDiedLocally(null);
    };
    const createWeaponCallbacks = (getWeapon) => ({
      getBotHitMeshes: () => {
        const bots = this.spawner.getHitMeshes();
        const players = this.isMultiplayer && this.network ? this.network.getHitMeshes() : [];
        return [...bots, ...players];
      },
      onBotHit: (bot, damage, point, headshot) => this.handleBotHit(bot, damage, point, headshot),
      onPlayerHit: (id, damage, headshot) => {
        if (this.isMultiplayer && this.network) {
          // A confirmed bullet hit is a damage report, nothing more. It never
          // implies the target died, and it never hides the target.
          this.network.sendHit(id, damage, headshot);
        }
      },
      onFired: (origin, direction) => {
        if (this.isMultiplayer && this.network) this.network.sendShot(origin, direction);
      },
      onAmmoChange: (magazine, reserve, reloading, elapsed, reloadDuration) => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(magazine, reserve, reloading, elapsed, getWeapon().config, reloadDuration);
      },
      onSpread: (spread) => {
        if (this.activeWeapon === getWeapon()) this.ui.setSpread(spread);
      },
      onReloadStart: () => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(getWeapon().magazine, getWeapon().reserve, true, 0, getWeapon().config, getWeapon().getReloadDuration());
      },
      onReloadProgress: (magazine, reserve, elapsed) => {
        if (this.activeWeapon === getWeapon()) this.ui.setAmmo(magazine, reserve, true, elapsed, getWeapon().config, getWeapon().getReloadDuration());
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
      config: GAME_CONFIG.weapon, modelUrl: '/models/m416rifle.glb?v=4', displayName: 'M416', targetLength: 1.15, viewScale: 1.15,
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

    this.tertiaryWeapon = new WeaponSystem({
      scene: this.scene, camera: this.camera, player: this.player, arena: this.arena, effects: this.effects, audio: this.audio,
      config: GAME_CONFIG.shotgun, modelUrl: '/models/shotgun.glb', displayName: 'Shotgun', targetLength: 1.45, viewScale: 1.45,
      basePosition: new THREE.Vector3(0.18, -0.37, -0.35), // Same placement
      callbacks: createWeaponCallbacks(() => this.tertiaryWeapon),
    });

    this.weapons = [this.primaryWeapon, this.secondaryWeapon, this.tertiaryWeapon];
    this.activeWeaponIndex = 0;
    this.activeWeapon = this.primaryWeapon;
    this.player.weapon = this.activeWeapon;
    this.secondaryWeapon.model.visible = false;
    this.tertiaryWeapon.model.visible = false;
    this.primaryWeapon.model.visible = false;

    this.input.onDigit1 = () => this.switchWeapon(0);
    this.input.onDigit2 = () => this.switchWeapon(1);
    this.input.onDigit3 = () => this.switchWeapon(2);
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
    // Multiplayer kill/death bar. Fed by NetworkManager from the server's own
    // score snapshots, so it can never contradict the authoritative score.
    this.scoreboard = new Scoreboard();
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
    // Losing window focus (alt-tab, Windows key, clicking away) no longer
    // pauses. InputManager.handleBlur already drops keys, fire and ADS state,
    // so the match simply carries on and you re-capture the mouse on click.
    // Escape is the only pause trigger.
    this.input.onBlur = () => {};
    this.input.onAnyInteraction = () => this.audio.resume();

    window.addEventListener('resize', () => this.resize());
    // Coming back from a hidden tab: re-show the "click to capture" prompt if
    // the match is still running but the mouse was released while away.
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) return;
      if (this.state !== 'PLAYING' || this.outcome) return;
      if (document.pointerLockElement !== this.renderer.domElement) {
        this.ui.setCaptureHint(true);
      }
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
    // Clear the previous match's bar here, synchronously, before the first
    // await. In PvP the server's `updateScores` can arrive while this function
    // is still suspended, so resetting any later would wipe a fresh score and
    // leave the bar blank until the next kill.
    this.scoreboard.reset();

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
      this.spawner.spawnMatch(this.player.root.position, this.difficulty, this.currentMapName);
      this.beginDuel();
    } else {
      this.spawner.clear();
      this.endDuel();
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
    // A downed multiplayer player must still be able to respawn, so pausing
    // (Escape / alt-tab) is not allowed to strand them.
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
    this.endDuel();
    this.scoreboard.reset();
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
    this.endDuel();
    this.scoreboard.reset();
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
    // Alt-tabbing also releases pointer lock, but the document is hidden at
    // that moment and the user did not ask to pause. Treat a hidden-document
    // unlock as "just lost the mouse" and keep playing; a visible-document
    // unlock (Escape, or focus moving to another window) still pauses.
    if (document.hidden) {
      this.ui.setCaptureHint(true);
      return;
    }
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
    if (this.isDuel) {
      // A duel round is lost, not the match: the next one spawns shortly.
      this.duelKills += 1;
      this.duelBotDeaths += 1;
      this.botRespawnPending = bot;
      this.botRespawnTimer = 1.6;
      this.refreshDuelScore();
      return;
    }
    if (this.spawner.getAlive() === 0) this.queueOutcome(true);
  }

  get isDuel() {
    return !this.isMultiplayer && this.difficulty?.count === 1;
  }

  /** Stand up the duel scoreboard for the current solo match. */
  beginDuel() {
    this.duelKills = 0;
    this.duelDeaths = 0;
    this.duelBotKills = 0;
    this.duelBotDeaths = 0;
    this.deathCam = null;
    this.botRespawnPending = null;
    this.botRespawnTimer = 0;
    // Reset first: refreshDuelScore only merges, so without this a previous
    // match's rows would survive into the new one.
    this.scoreboard.reset();
    if (this.isDuel) this.refreshDuelScore();
  }

  endDuel() {
    this.deathCam = null;
    this.botRespawnPending = null;
    this.botRespawnTimer = 0;
    this.soloDeathHandling = false;
    this.ui.setDuelBanner(null);
  }

  /**
   * Push the duel score into the same top scoreboard the PvP view uses. Ids are
   * stable ('you' and one per bot type) so a respawned bot keeps its tally.
   */
  refreshDuelScore() {
    if (!this.isDuel) return;
    const map = {};
    map[this.LOCAL_ME] = {
      id: this.LOCAL_ME, kills: this.duelKills, deaths: this.duelDeaths,
      dead: !!(this.deathCam || this.player.health.dead),
    };
    const bot = this.spawner.bots[0];
    if (bot) {
      map[this.duelBotId(bot)] = {
        id: this.duelBotId(bot), name: bot.type.name,
        kills: this.duelBotKills, deaths: this.duelBotDeaths,
        dead: !!bot.dead,
      };
    }
    this.scoreboard.sync(map, this.LOCAL_ME);
  }

  duelBotId(bot) {
    return `bot-${bot.typeKey}`;
  }

  /**
   * Solo death: hold a short death cam on whoever shot us, then respawn both
   * sides for the next round instead of ending the match.
   */
  beginDeathCam(killer) {
    const live = killer && !killer.removed ? killer : null;
    this.deathCam = {
      timer: DEATH_CAM_SECONDS,
      killerName: live ? live.type.name : null,
      // The killer is still alive and fighting, so track its live position
      // rather than freezing on the spot it shot us from.
      killer: live,
      look: live ? live.root.position.clone().setY(1.1) : null,
      shownSecond: Math.ceil(DEATH_CAM_SECONDS),
    };
    this.input.setEnabled(false);
    this.ui.setADS(0);
    // Paint the countdown immediately rather than on the next tick, so the
    // banner is never a frame behind the kill.
    this.ui.setDuelBanner(DEATH_CAM_SECONDS, this.deathCam.killerName);
  }

  updateDeathCam(delta) {
    const cam = this.deathCam;
    if (!cam) return;
    cam.timer -= delta;

    // Copy, never alias: look is mutated with setY() below, and that must not
    // reach back into the bot's own root.position.
    if (cam.killer && !cam.killer.removed) cam.look.copy(cam.killer.root.position);
    if (cam.look) {
      // The camera is a child of the (now frozen) player root, so lookAt in
      // world space is exact and we never fight the player's own yaw/pitch.
      this.camera.lookAt(cam.look.setY(1.1));
    }
    // Only rewrite the banner when the visible second actually changes.
    const second = Math.max(1, Math.ceil(Math.max(0, cam.timer)));
    if (second !== cam.shownSecond) {
      cam.shownSecond = second;
      this.ui.setDuelBanner(Math.max(0, cam.timer), cam.killerName);
    }

    if (cam.timer > 0) return;
    this.deathCam = null;
    this.ui.setDuelBanner(null);
    this.respawnDuelRound();
  }

  respawnDuelRound() {
    this.player.reset(this.arena.getPlayerSpawn());
    this.activeWeapon.reset();
    this.input.setEnabled(true);
    this.input.clear();
    this.ui.setHealth(this.player.health.current, this.player.health.maxHealth);
    this.ui.setAmmo(this.activeWeapon.magazine, this.activeWeapon.reserve, false, 0, this.activeWeapon.config);
    this.requestPlayablePointerLock();
    this.refreshDuelScore();
  }

  /** Bring the opponent back for the next duel round. */
  updateDuelBotRespawn(delta) {
    if (!this.botRespawnPending) return;
    const bot = this.botRespawnPending;
    if (!bot.removed) return; // wait for the death animation to finish
    this.botRespawnTimer -= delta;
    if (this.botRespawnTimer > 0) return;
    this.botRespawnPending = null;
    this.spawner.respawn(bot, this.player.root.position, this.difficulty);
    this.updateDynamicActors();
    this.ui.setEnemies(this.spawner.getAlive());
    this.refreshDuelScore();
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

  /**
   * Applies damage that the server says landed on us. Health is the only thing
   * that changes: no remote mesh is touched and no death is inferred locally.
   * The server owns the alive/dead verdict and will send `playerDied`.
   */
  applyLocalDamage(damage, authoritativeHealth = null) {
    if (Number.isFinite(authoritativeHealth)) {
      // Adopt the server's number so both clients agree.
      this.player.health.setHealth(authoritativeHealth);
    } else {
      this.player.health.damage(damage);
    }
    // Flash the damage vignette. player.damageFlash is already set by the
    // health system's onDamage hook and decays on its own in PlayerController,
    // so nothing extra is needed here - this only paints it for one frame.
    this.ui.setDamageFlash(Math.max(this.player.damageFlash, 0.35));
  }

  /** Authoritative verdict about our own player, forwarded by the network. */
  onAuthoritativeSelfState(state) {
    if (!state) return;
    if (state.isAlive === false || state.health <= 0) {
      this.player.health.kill();
    } else if (Number.isFinite(state.health)) {
      this.player.health.setHealth(state.health);
    }
  }

  playerDiedLocally(killerId) {
    if (this.soloDeathHandling) return;
    if (this.isMultiplayer) {
      // Guard on the authoritative death flag, not on the outcome system: in
      // PvP the solo defeat/outcome flow must never run.
      if (this.respawnPending) return;
      this.respawnPending = true;
      this.respawnTimer = 3; // seconds
      this.respawnKillerId = killerId;
      this.player.health.kill();
      this.ui.announceKill('You were killed!');
      return;
    }

    if (this.outcome !== null || this.deathCam) return;

    // health.kill() fires onDeath, which routes straight back into this method.
    // The reentrancy guard below is the ONLY thing keeping that from counting a
    // single death twice, so the branch state (deathCam / outcome) is always
    // committed *before* kill() runs, and the guard exists as a hard backstop.
    this.soloDeathHandling = true;

    // In the 1v1 duel a death is a lost round, not a lost match: hold the death
    // cam on the bot that shot us, then respawn.
    if (this.isDuel) {
      this.duelDeaths += 1;
      this.duelBotKills += 1;
      this.beginDeathCam(this.player.lastDamager);
      this.refreshDuelScore();
    } else {
      this.queueOutcome(false);
    }

    this.player.health.kill();
    this.soloDeathHandling = false;
  }

  /**
   * Runs the multiplayer respawn countdown. It is driven by the update loop
   * rather than a raw setTimeout, so pausing or alt-tabbing during the death
   * window can no longer cancel it and strand the player invisible.
   */
  updateMultiplayerRespawn(delta) {
    if (!this.respawnPending) return;
    this.respawnTimer -= delta;
    if (this.respawnTimer > 0) return;

    this.respawnPending = false;
    const avoidPosition = this.respawnKillerId && this.network?.remotePlayers.has(this.respawnKillerId)
      ? this.network.remotePlayers.get(this.respawnKillerId).mesh.position
      : null;
    const newSpawn = this.arena.getPlayerSpawn(avoidPosition);
    this.player.reset(newSpawn);
    this.respawnKillerId = null;
    this.network?.socket?.emit('respawn', { x: newSpawn.x, y: newSpawn.y, z: newSpawn.z });
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
    // The respawn countdown advances even while paused or dead, so a downed
    // player always comes back regardless of window focus.
    if (this.isMultiplayer) this.updateMultiplayerRespawn(delta);
    if (this.isDuel) this.updateDuelBotRespawn(delta);

    // Death cam owns the frame: the player is frozen and the camera watches
    // the bot that killed them until the round resets.
    if (this.deathCam) {
      this.spawner.update(delta, { player: this.player, elapsed: this.elapsed });
      this.updateDeathCam(delta);
      this.ui.setDamageFlash(0);
      return;
    }

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
      // A downed player is outside the normal match flow, so their respawn
      // countdown is ticked here too. Same for the solo death cam: pausing
      // mid-cam must not strand the duel.
      else {
        if (this.isMultiplayer && this.respawnPending) this.updateMultiplayerRespawn(delta);
        if (this.deathCam) this.updateDeathCam(delta);
      }

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