import * as THREE from 'three';
import { GAME_CONFIG, WEAPON_MODELS } from '../config.js';
import { InputManager } from './InputManager.js';
import { AudioManager } from './AudioManager.js';
import { EffectPool } from './EffectPool.js';
import { ArenaMap } from '../world/ArenaMap.js';
import { NavigationGrid } from '../navigation/NavigationGrid.js';
import { PlayerController } from '../player/PlayerController.js';
import { WeaponSystem } from '../player/WeaponSystem.js';
import { BotSpawner } from '../enemies/BotSpawner.js';
import { loadBotSkin } from '../characters/MinecraftCharacter.js';
import { preloadHeldWeapons } from '../characters/HeldWeapons.js';
import { UIManager } from '../ui/UIManager.js';
import { Scoreboard } from '../ui/Scoreboard.js';
import { NetworkManager } from './NetworkManager.js';

// How long the solo death cam holds on the killer before the round respawns.
const DEATH_CAM_SECONDS = 2.6;
// How long a killed duel bot stays down before it comes back. Overlaps the
// player's death cam so both sides return around the same time.
const DUEL_BOT_RESPAWN_SECONDS = 2.6;

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

    // === Viewmodel lighting rig ===
    // The gun sits centimeters from the lens and is extremely sensitive to
    // whatever angle the world lights come from. A three-light rig parented to
    // the camera keeps it evenly lit regardless of facing direction.
    //
    // Key light: warm, slightly above and right — this is the main gun fill.
    this.viewmodelLight = new THREE.DirectionalLight(0xfff2d9, 1.6);
    this.viewmodelLight.position.set(0.3, 0.6, 0.4);
    this.viewmodelLightTarget = new THREE.Object3D();
    this.viewmodelLightTarget.position.set(0, -0.3, -1);
    this.viewmodelLight.target = this.viewmodelLightTarget;
    this.viewmodelLight.castShadow = false;
    this.camera.add(this.viewmodelLight);
    this.camera.add(this.viewmodelLightTarget);

    // Fill light: cool, from the opposite side so the left side of the gun
    // isn't a flat black silhouette. Kept dimmer than the key.
    this.viewmodelFill = new THREE.DirectionalLight(0xc8deff, 0.7);
    this.viewmodelFill.position.set(-0.4, 0.3, 0.2);
    this.viewmodelFillTarget = new THREE.Object3D();
    this.viewmodelFillTarget.position.set(0.1, -0.2, -1);
    this.viewmodelFill.target = this.viewmodelFillTarget;
    this.viewmodelFill.castShadow = false;
    this.camera.add(this.viewmodelFill);
    this.camera.add(this.viewmodelFillTarget);

    // Rim/back light: subtle warm highlight on the top edge of the gun for
    // depth separation against the background.
    this.viewmodelRim = new THREE.DirectionalLight(0xffe8c0, 0.4);
    this.viewmodelRim.position.set(0, 0.8, 0.8);
    this.viewmodelRimTarget = new THREE.Object3D();
    this.viewmodelRimTarget.position.set(0, -0.1, -0.6);
    this.viewmodelRim.target = this.viewmodelRimTarget;
    this.viewmodelRim.castShadow = false;
    this.camera.add(this.viewmodelRim);
    this.camera.add(this.viewmodelRimTarget);

    this.scene.add(this.camera); // camera must be in the scene graph for its children to render

    // === Renderer ===
    this.renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 0.92;
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.applyGraphicsQuality(localStorage.getItem('graphicsQuality') || 'high');
    this.renderer.setSize(window.innerWidth, window.innerHeight);
    this.renderer.domElement.id = 'game-canvas';
    this.renderer.domElement.setAttribute('aria-label', 'PolyKrodh 3D arena');
    container.querySelector('#viewport').appendChild(this.renderer.domElement);

    // === Environment map for PBR reflections ===
    // Without an environment map, metallic/glossy materials (gun parts, metal
    // surfaces) look pitch black because there is nothing to reflect. A PMREM-
    // processed procedural gradient gives every MeshStandardMaterial in the
    // scene something to reflect, bringing out realistic specular highlights.
    this.buildEnvironmentMap();

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
      config: GAME_CONFIG.weapon, ...WEAPON_MODELS[0],
      // The rifle's HIP pose, used as the base the shoulder hold is measured
      // from. It sits lower than it shipped. This is the hip pose only - the
      // default carry is the shoulder hold above it, and ADS derives its own y
      // from the model's adsaimpoint, so the sight picture is untouched.
      basePosition: new THREE.Vector3(0.18, -0.40, -0.35), // Same placement as before
      modelOffset: new THREE.Vector3(0, 0, 0), // Reset offset so it doesn't stick out forward
      callbacks: createWeaponCallbacks(() => this.primaryWeapon),
    });

    this.secondaryWeapon = new WeaponSystem({
      scene: this.scene, camera: this.camera, player: this.player, arena: this.arena, effects: this.effects, audio: this.audio,
      config: GAME_CONFIG.secondaryWeapon, ...WEAPON_MODELS[1],
      basePosition: new THREE.Vector3(0.18, -0.37, -0.35), // Same placement as M4
      callbacks: createWeaponCallbacks(() => this.secondaryWeapon),
    });

    this.tertiaryWeapon = new WeaponSystem({
      scene: this.scene, camera: this.camera, player: this.player, arena: this.arena, effects: this.effects, audio: this.audio,
      // `viewScale` is trimmed slightly off the rifle/shotgun default of 1.45 so the
      // shotgun reads a touch smaller without changing its proportions -
      // `targetLength` is left alone so the model still fits itself correctly.
      config: GAME_CONFIG.shotgun, ...WEAPON_MODELS[2],
      basePosition: new THREE.Vector3(0.18, -0.37, -0.35), // Same placement
      callbacks: createWeaponCallbacks(() => this.tertiaryWeapon),
    });

    // The sniper is the longest gun in the game. Its `targetLength` of 1.66 fits the
    // mesh to its real barrel proportions, but where it sits is set below.
    this.quaternaryWeapon = new WeaponSystem({
      scene: this.scene, camera: this.camera, player: this.player, arena: this.arena, effects: this.effects, audio: this.audio,
      config: GAME_CONFIG.sniper, ...WEAPON_MODELS[3],
      // The sniper's HIP pose, which the default shoulder hold is measured
      // from: further right, higher and further forward than the other three
      // guns. The forward push is what keeps the bolt handle and magazine on
      // screen - both sit far back on this model, and at the rifle's depth they
      // fall behind the near plane. Pushing forward also buys them margin, so
      // the bolt never clips.
      //
      // `adsForwardOffset` is this gun's own, so the scoped view can be held
      // still while the hip pose moves. At -0.70 the default -0.07 would put ADS
      // at -0.77; -0.02 keeps it at the -0.72 this gun was tuned to, leaving
      // the scoped sight picture exactly as it is.
      basePosition: new THREE.Vector3(0.26, -0.34, -0.70),
      adsForwardOffset: -0.02,
      // Support (left) hand, in model space: +Z is back toward the eye, -Y is
      // down. The GLB has no handguard node to hang a fist from, so this hand
      // lands on the generic rifle fallback at (-0.04, -0.01, -0.20), which
      // reaches too far forward and sits too high for a gun this long. Pulling
      // it back and down keeps the fist on the forestock instead of out in
      // front of the barrel.
      leftHandOffset: new THREE.Vector3(0, -0.24, 0.13),
      // No grip hand on this rifle. The GLB has no grip node to hang it from, so
      // the fist would land on the generic fallback a few centimetres off the
      // stock, floating beside the receiver rather than holding it. The other
      // three guns keep theirs, and this is a per-weapon flag so it cannot reach
      // them.
      showRightHand: false,
      modelOffset: new THREE.Vector3(0, 0, 0),
      callbacks: createWeaponCallbacks(() => this.quaternaryWeapon),
    });

    this.weapons = [this.primaryWeapon, this.secondaryWeapon, this.tertiaryWeapon, this.quaternaryWeapon];
    this.activeWeaponIndex = 0;
    this.activeWeapon = this.primaryWeapon;
    this.player.weapon = this.activeWeapon;
    this.secondaryWeapon.model.visible = false;
    this.tertiaryWeapon.model.visible = false;
    this.quaternaryWeapon.model.visible = false;
    this.primaryWeapon.model.visible = false;

    this.input.onDigit1 = () => this.switchWeapon(0);
    this.input.onDigit2 = () => this.switchWeapon(1);
    this.input.onDigit3 = () => this.switchWeapon(2);
    this.input.onDigit4 = () => this.switchWeapon(3);
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
    // The wheel does double duty. While a scoped weapon is aimed, it steps the
    // magnification instead of cycling weapons, so the zoom stays under your
    // finger and you never drop out of the scope to swap guns. The test is
    // "does this weapon have an optic and are we looking through it", NOT the
    // result of the zoom itself: a wheel notch at the end stop has to be
    // swallowed, or it would fall through and change weapon mid-scope.
    // Everything else - hip firing, or a weapon with no optic - cycles as before.
    const scopedWheel = () => this.input.ads && Boolean(this.activeWeapon?.config?.scope);
    this.input.onScrollUp = () => {
      if (scopedWheel()) this.activeWeapon.zoomScope(1);
      else this.switchWeapon((this.activeWeaponIndex + 1) % this.weapons.length);
    };
    this.input.onScrollDown = () => {
      if (scopedWheel()) this.activeWeapon.zoomScope(-1);
      else this.switchWeapon((this.activeWeaponIndex - 1 + this.weapons.length) % this.weapons.length);
    };

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
      // Team selection. Routed straight to the socket - the server decides
      // whether the slot is really free and tells everyone, so this does not
      // touch any team state of its own.
      selectTeam: (intent) => this.network?.selectTeam(intent),
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
      this.scene.fog = new THREE.Fog(0x1a1614, 15, 120);
    } else {
      // A saturated, believable sky — not pure white-blue.
      this.scene.background = new THREE.Color(0x6ba3d6);
      // Atmospheric perspective: strong contrast near, fading to haze far.
      // Fog colour is slightly warmer/lighter than the sky to read as haze.
      this.scene.fog = new THREE.Fog(0x9cb8d4, 40, 220);
    }
    // Rebuild the environment map so reflections match the new map's palette.
    this.buildEnvironmentMap();
  }

  async init() {
    await this.arena.loadMapModel('arena');
    this.navigation.build(this.arena);
    this.currentMapName = 'arena';
    this.updateEnvironment('arena');

    // The 1v1 opponent wears a real skin file instead of the procedural one.
    // Seeded before the menu appears so the very first duel already has it, and
    // non-fatal: a missing file just leaves the old procedural PRO skin in place
    // rather than stranding the game on the loading screen.
    await loadBotSkin('pro', '/pictures/skins-de-minecraft.png')
      .catch((error) => console.warn('Falling back to the procedural PRO skin.', error));

    // The four weapon models, so a multiplayer opponent can be seen holding the
    // gun they actually picked. Fetched alongside the skins rather than awaited
    // as a gate: a gun that is late or missing leaves the character with its
    // premade rifle instead of holding up the menu.
    preloadHeldWeapons();

    // All four, so the sniper can never be selected while its model is still
    // loading and hand the player the fallback box instead.
    await Promise.all([
      this.primaryWeapon.ready,
      this.secondaryWeapon.ready,
      this.tertiaryWeapon.ready,
      this.quaternaryWeapon.ready,
    ]);
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
        // Tell the room which gun is in our hands now, so our character is seen
        // holding this weapon rather than the one it was holding a moment ago.
        if (this.isMultiplayer && this.network) this.network.sendWeaponChanged(this.activeWeaponIndex);

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
    this.ui.setScopeOverlay(false, 0);
    this.ui.setScopeReadout(0, false);
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
    const weaponName = this.player.weapon?.config?.name?.toLowerCase().replace(/\s/g, '') || 'assaultrifle';
    this.ui.announceKill('YOU', bot.type.name.toUpperCase(), weaponName, true, false);
    this.ui.setEnemies(this.spawner.getAlive());
    if (this.isDuel) {
      // A duel round is lost, not the match: the bot comes back shortly, at a
      // random map spawn, and the fight continues.
      this.duelKills += 1;
      this.duelBotDeaths += 1;
      this.botRespawnPending = bot;
      this.botRespawnTimer = DUEL_BOT_RESPAWN_SECONDS;
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
    // Dying while aimed would otherwise leave the scope overlay covering the
    // death cam, and the viewmodel hidden, since neither is driven once the
    // weapon stops updating.
    this.ui.setScopeOverlay(false, 0);
    this.ui.setScopeReadout(0, false);
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

  /**
   * A random map spawn for the next duel round. getPlayerSpawn already picks
   * uniformly from the map's own spawn points, so the player never keeps
   * landing in the same place.
   */
  pickDuelSpawn(avoidPosition = null) {
    return this.arena.getPlayerSpawn(avoidPosition);
  }

  respawnDuelRound() {
    // The respawn point is drawn at random from the map's spawns, and the
    // player's own reset covers health, weapon/ammo/reload, camera, movement
    // and every other piece of state the controller owns.
    this.player.reset(this.pickDuelSpawn());
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
    this.botRespawnTimer -= delta;
    if (this.botRespawnTimer > 0) return;
    const bot = this.botRespawnPending;
    this.botRespawnPending = null;
    // The dead bot is usually already out of the list (update() drops removed
    // bots), so respawn() appends the fresh one rather than failing.
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
      this.ui.announceKill('ENEMY', 'YOU', 'assaultrifle', false, true);
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
      if (!this.respawnPending) {
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
      } else {
        // While waiting to respawn, force weapon hidden and apply gravity/friction
        // so the corpse drops to the floor but player can't move or aim.
        this.player.update(delta, false); 
        if (this.activeWeapon.weaponHolder) {
          this.activeWeapon.weaponHolder.visible = false;
        }
      }
      this.spawner.update(delta, { player: this.player, elapsed: this.elapsed });
      this.activeWeapon.updateTransientEffects(delta);
      // The optic readout and the screen-space scope both follow the active
      // weapon's scope, so they appear the moment the sniper is aimed and
      // track the scroll wheel. A weapon with no optic reports 0 and both
      // switch themselves off. `scope` is read first because setADS needs it:
      // a scoped weapon hands its crosshair over to the reticle and is excluded
      // from the usual crosshair-hides-on-aim behaviour.
      const scope = this.activeWeapon.getScopeMagnification() > 0;
      this.ui.setADS(this.player.adsAmount, scope);
      this.ui.setMoveState(this.player.adsActive ? 'AIM' : this.player.sprinting && this.player.currentSpeed > 4.5 ? 'SPRINT' : this.player.grounded ? 'READY' : 'AIRBORNE');
      this.ui.setScopeReadout(this.activeWeapon.getScopeMagnification(), this.player.adsActive);
      this.ui.setScopeOverlay(scope, this.player.adsAmount);
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
        this.renderer.shadowMap.type = THREE.PCFShadowMap;
        break;
      case 'high':
        this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5));
        this.renderer.shadowMap.enabled = true;
        this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
        break;
      case 'ultra':
        this.renderer.setPixelRatio(Math.max(window.devicePixelRatio, 2.0));
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

  /**
   * Generates a procedural environment cubemap and assigns it to the scene.
   *
   * Without an environment map, every MeshStandardMaterial with any metalness
   * looks pitch-black because there is literally nothing for the PBR shader
   * to reflect. This gives every surface in the game a soft gradient to
   * bounce off of — the guns get specular highlights, metal railings catch
   * light, and even diffuse surfaces benefit from the ambient term.
   *
   * The gradient is generated once in a tiny offscreen cube render target and
   * processed through Three's PMREM pipeline, so it costs almost nothing at
   * runtime.
   */
  buildEnvironmentMap() {
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    pmrem.compileEquirectangularShader();

    // Build a tiny scene with a gradient background for the cubemap capture.
    const envScene = new THREE.Scene();

    // Sky gradient: top colour (zenith) to bottom (ground bounce).
    // Read from the current scene background so it matches indoor/outdoor.
    const bg = this.scene.background;
    const isIndoor = bg && bg.r < 0.2 && bg.g < 0.2 && bg.b < 0.2;

    // For the cubemap we paint six faces with a colour that represents what
    // that hemisphere would bounce. Outdoors that is bright sky above and
    // warm earth below; indoors it is dim warm ceiling and darker floor.
    // Darker, more saturated gradient — the old values were too bright and
    // washed out every surface that reflected them.
    const topColor    = isIndoor ? new THREE.Color(0x2a2520) : new THREE.Color(0x4a7a9e);
    const horizColor  = isIndoor ? new THREE.Color(0x1e1a16) : new THREE.Color(0x9a9080);
    const bottomColor = isIndoor ? new THREE.Color(0x100e0a) : new THREE.Color(0x4a4030);

    // A large sphere with a vertex-colour gradient serves as the environment.
    const geo = new THREE.SphereGeometry(100, 32, 16);
    const colors = new Float32Array(geo.attributes.position.count * 3);
    const posAttr = geo.attributes.position;
    for (let i = 0; i < posAttr.count; i++) {
      const y = posAttr.getY(i) / 100; // -1..1
      let c;
      if (y > 0) {
        c = horizColor.clone().lerp(topColor, y);
      } else {
        c = horizColor.clone().lerp(bottomColor, -y);
      }
      colors[i * 3]     = c.r;
      colors[i * 3 + 1] = c.g;
      colors[i * 3 + 2] = c.b;
    }
    geo.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    const mat = new THREE.MeshBasicMaterial({ vertexColors: true, side: THREE.BackSide });
    envScene.add(new THREE.Mesh(geo, mat));

    const envMap = pmrem.fromScene(envScene, 0, 0.1, 1000).texture;
    this.scene.environment = envMap;
    pmrem.dispose();
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
      // Drives the scoreboard's match clock. It only writes to the DOM when the
      // displayed second changes, so this is cheap enough to run every frame.
      this.scoreboard?.tick();

      this.effects.update(delta);
      this.audio.updateListener(this.camera);
      this.input.endFrame();
      this.renderer.render(this.scene, this.camera);
      requestAnimationFrame(frame);
    };
    requestAnimationFrame(frame);
  }
}