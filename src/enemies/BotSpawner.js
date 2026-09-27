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

  spawnMatch(playerSpawn, difficulty) {
    this.clear();
    const typeOrder = this.buildTypeOrder(difficulty.count);
    const spawnPoints = [];
    for (let i = 0; i < difficulty.count; i++) {
      let spawn = null;
      for (let attempts = 0; attempts < 150; attempts++) {
        const x = Math.floor(Math.random() * this.navigation.size);
        const z = Math.floor(Math.random() * this.navigation.size);
        if (this.navigation.isWalkableCell(x, z)) {
          const pt = this.navigation.cellToWorld(x, z);
          if (pt.distanceTo(playerSpawn) > 20) {
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

    typeOrder.forEach((type, index) => {
      const spawn = spawnPoints[index];
      const bot = new EnemyAI({
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
      });
      this.bots.push(bot);
    });
    return this.bots;
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
