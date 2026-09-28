import * as THREE from 'three';
import { EnemyAI } from './EnemyAI.js';

export class BotSpawner {
  constructor({ scene, arena, navigation, effects, audio, onDeath }) {
    this.scene = scene;
    this.arena = arena;
    this.navigation = navigation;
    this.effects = effects;
    this.audio = audio;
    this.onDeath = onDeath;
    this.bots = [];
    this.coverClaims = new Map();
    this.nextId = 1;
  }

  spawnMatch(playerSpawn, difficulty, mapName) {
    this.clear();
    this.mapName = mapName ?? this.mapName ?? 'arena';
    // A difficulty can pin the bot type (the 1v1 duel always wants the pro);
    // otherwise fall back to the normal random type rotation.
    const forcedType = difficulty.botType;
    const typeOrder = forcedType
      ? new Array(difficulty.count).fill(forcedType)
      : this.buildTypeOrder(difficulty.count);
    const spawnPoints = this.pickSpawnPoints(playerSpawn, difficulty.count, 20);

    typeOrder.forEach((type, index) => {
      this.bots.push(this.createBot(type, spawnPoints[index], difficulty));
    });
    return this.bots;
  }

  /**
   * Replace a dead bot with a fresh one at the same slot. Used by the 1v1 duel
   * so a round ends and a new one begins instead of ending the match.
   *
   * The dead bot is normally gone from `this.bots` by the time this runs
   * (update() drops removed bots), so a missing entry is normal, not an error:
   * the fresh bot is simply appended. A dead bot still in the list is replaced
   * in place so its cover claim and slot are released in order.
   */
  respawn(bot, playerSpawn, difficulty) {
    const type = difficulty.botType || bot.typeKey;
    const fresh = this.createBot(type, this.pickRespawnPoint(playerSpawn), difficulty);
    const index = this.bots.indexOf(bot);
    if (index >= 0) {
      this.bots[index] = fresh;
    } else {
      this.bots.push(fresh);
    }
    return fresh;
  }

  /**
   * Where a respawning bot appears. Maps that ship their own spawn points use
   * them, drawn at random on every respawn so a round never repeats the same
   * spot; everything else falls back to the existing nav-grid search. The
   * chosen point is ground-snapped, so it can never be inside geometry.
   */
  pickRespawnPoint(playerSpawn) {
    const mapSpawns = this.arena.botSpawns;
    if (this.arena.hasMapSpawns && mapSpawns?.length) {
      const pick = mapSpawns[Math.floor(Math.random() * mapSpawns.length)].clone();
      const snapped = this.arena.groundSnap(pick, 0.45, 1.85);
      return snapped ?? pick;
    }
    return this.pickSpawnPoints(playerSpawn, 1, 14)[0];
  }

  createBot(type, spawn, difficulty) {
    return new EnemyAI({
      scene: this.scene,
      arena: this.arena,
      navigation: this.navigation,
      effects: this.effects,
      audio: this.audio,
      type,
      spawn,
      difficulty,
      id: this.nextId++,
      coverClaims: this.coverClaims,
      onDeath: this.onDeath,
      mapName: this.mapName,
    });
  }

  pickSpawnPoints(playerSpawn, count, minDistance) {
    const spawnPoints = [];
    for (let i = 0; i < count; i++) {
      let spawn = null;
      for (let attempts = 0; attempts < 150; attempts++) {
        const x = Math.floor(Math.random() * this.navigation.size);
        const z = Math.floor(Math.random() * this.navigation.size);
        if (this.navigation.isWalkableCell(x, z)) {
          const pt = this.navigation.cellToWorld(x, z);
          if (pt.distanceTo(playerSpawn) > minDistance) {
            const tooClose = spawnPoints.some(s => s.distanceTo(pt) < 1.5);
            if (!tooClose) {
              const snapped = this.arena.groundSnap(pt, 0.45, 1.85);
              if (snapped) {
                spawn = snapped;
                break;
              }
            }
          }
        }
      }
      if (!spawn) {
        spawn = this.arena.botSpawns[i % this.arena.botSpawns.length].clone();
        if (this.arena.hasMapSpawns) spawn.setY(spawn.y + 1.5);
      }
      spawnPoints.push(spawn);
    }
    return spawnPoints;
  }

  buildTypeOrder(count) {
    const order = [];
    while (order.length < count) {
      order.push('normal', 'aggressive', 'defensive');
      if (count >= 7) order.push('normal', 'aggressive');
    }
    shuffle(order);
    return order.slice(0, count);
  }

  update(delta, context) {
    for (const bot of this.bots) {
      if (!bot.removed) bot.update(delta, context);
    }
    if (this.bots.some((bot) => bot.removed)) {
      this.bots = this.bots.filter((bot) => !bot.removed);
    }
  }

  getHitMeshes() {
    const meshes = [];
    for (const bot of this.bots) {
      if (!bot.dead && !bot.removed) {
        // Weapon raycasts happen between AI and render updates; refresh here so
        // fast-moving bots are sampled at their current transform, not last frame's.
        bot.root.updateMatrixWorld(true);
        meshes.push(...bot.hitMeshes);
      }
    }
    return meshes;
  }

  getAlive() {
    return this.bots.filter((bot) => !bot.dead).length;
  }

  clear() {
    for (const bot of this.bots) bot.remove();
    this.bots.length = 0;
    this.coverClaims.clear();
  }
}

function shuffle(array) {
  for (let index = array.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1));
    [array[index], array[swap]] = [array[swap], array[index]];
  }
}
