import * as THREE from 'three';
import { GAME_CONFIG } from '../config.js';

const HALF_SIZE = GAME_CONFIG.arenaHalfSize - 1;
const CELL_SIZE = 1.25;
const GRID_SIZE = Math.ceil((HALF_SIZE * 2) / CELL_SIZE) + 1;
const AGENT_RADIUS = 0.5;
const AGENT_HEIGHT = 1.8;
// Only surfaces the body could actually stand on count as ground.
const GROUND_SEARCH_HEIGHT = 3.2;

export class NavigationGrid {
  constructor(arena) {
    this.arena = arena;
    this.size = GRID_SIZE;
    this.cellSize = CELL_SIZE;
    this.halfSize = HALF_SIZE;
    this.blocked = new Uint8Array(GRID_SIZE * GRID_SIZE);
    this.reachable = new Uint8Array(GRID_SIZE * GRID_SIZE);
    this.groundY = new Float32Array(GRID_SIZE * GRID_SIZE);
    this.build();
    arena.setNavigation(this);
  }

  build(arena = this.arena) {
    if (arena) this.arena = arena;
    this.blocked.fill(0);
    this.reachable.fill(0);
    this.groundY.fill(0);

    const collision = this.arena?.collision;
    const floorY = this.arena?.floorY ?? 0;

    for (let cz = 0; cz < this.size; cz += 1) {
      for (let cx = 0; cx < this.size; cx += 1) {
        const world = this.cellToWorld(cx, cz, this._scratch ?? (this._scratch = new THREE.Vector3()));
        const index = this.index(cx, cz);
        let ground = floorY;

        if (collision?.ready) {
          const found = collision.groundHeight(world.x, world.z, AGENT_RADIUS, floorY + GROUND_SEARCH_HEIGHT, GROUND_SEARCH_HEIGHT + 2);
          if (!Number.isFinite(found) || found > floorY + GROUND_SEARCH_HEIGHT) {
            this.blocked[index] = 1;
            continue;
          }
          ground = found;
          // A body standing here must fit, and must not be walled in.
          if (collision.overlapsCylinder(world.x, world.z, ground, ground + AGENT_HEIGHT, AGENT_RADIUS, 0.25)) {
            this.blocked[index] = 1;
            continue;
          }
        }

        this.groundY[index] = ground;
        this.blocked[index] = 0;
      }
    }

    this.applyColliderObstructions();
    this.buildReachableComponent();
  }

  /**
   * Adds the hand placed AABB props (crates, barriers, procedural cover) on top
   * of the triangle accurate pass.
   */
  applyColliderObstructions() {
    for (const collider of this.arena?.colliders ?? []) {
      if (collider.isTerrain) continue;
      if (collider.min.y >= 2.1 || collider.max.y <= 0.4) continue;
      const minX = this.worldToCell(collider.min.x - AGENT_RADIUS);
      const maxX = this.worldToCell(collider.max.x + AGENT_RADIUS);
      const minZ = this.worldToCell(collider.min.z - AGENT_RADIUS);
      const maxZ = this.worldToCell(collider.max.z + AGENT_RADIUS);
      for (let z = minZ; z <= maxZ; z += 1) {
        for (let x = minX; x <= maxX; x += 1) {
          if (x < 0 || z < 0 || x >= this.size || z >= this.size) continue;
          this.blocked[this.index(x, z)] = 1;
        }
      }
    }
  }

  /** Ground height sampled when the grid was built. */
  getGroundAt(x, z) {
    const cell = this.index(this.worldToCell(x), this.worldToCell(z));
    const value = this.groundY[cell];
    return value === 0 ? (this.arena?.floorY ?? 0) : value;
  }

  buildReachableComponent() {
    let start = -1;
    // Prefer to start flood fill at the first player spawn to guarantee the interior is marked reachable
    const defaultSpawn = this.arena?.playerSpawns?.[0] || { x: 0, z: 0 };
    const preferred = this.index(this.worldToCell(defaultSpawn.x), this.worldToCell(defaultSpawn.z));
    
    if (this.blocked[preferred] === 0) start = preferred;
    if (start < 0) {
      // Try (0,0) as a fallback interior point
      const origin = this.index(this.worldToCell(0), this.worldToCell(0));
      if (this.blocked[origin] === 0) start = origin;
    }
    if (start < 0) {
      for (let index = 0; index < this.blocked.length; index += 1) {
        if (this.blocked[index] === 0) {
          start = index;
          break;
        }
      }
    }
    if (start < 0) return;

    const queue = new Int32Array(this.blocked.length);
    let head = 0;
    let tail = 0;
    queue[tail++] = start;
    this.reachable[start] = 1;
    while (head < tail) {
      const current = queue[head++];
      const currentX = current % this.size;
      const currentZ = Math.floor(current / this.size);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          const nextX = currentX + dx;
          const nextZ = currentZ + dz;
          if (nextX < 0 || nextZ < 0 || nextX >= this.size || nextZ >= this.size) continue;
          const nextIndex = this.index(nextX, nextZ);
          if (this.blocked[nextIndex] || this.reachable[nextIndex]) continue;
          if (dx !== 0 && dz !== 0 && (
            this.blocked[this.index(currentX + dx, currentZ)]
            || this.blocked[this.index(currentX, currentZ + dz)]
          )) continue;
          this.reachable[nextIndex] = 1;
          queue[tail++] = nextIndex;
        }
      }
    }
  }

  index(x, z) {
    return z * this.size + x;
  }

  worldToCell(value) {
    return THREE.MathUtils.clamp(Math.floor((value + this.halfSize) / this.cellSize), 0, this.size - 1);
  }

  cellToWorld(x, z, target = new THREE.Vector3()) {
    const sampled = this.groundY[this.index(x, z)];
    const floor = this.arena?.floorY ?? 0;
    return target.set(
      -this.halfSize + (x + 0.5) * this.cellSize,
      (sampled === 0 ? floor : sampled) + 0.08,
      -this.halfSize + (z + 0.5) * this.cellSize,
    );
  }

  isWalkableCell(x, z) {
    return x >= 0 && z >= 0 && x < this.size && z < this.size
      && this.blocked[this.index(x, z)] === 0
      && this.reachable[this.index(x, z)] === 1;
  }

  isWalkablePoint(point) {
    return this.isWalkableCell(this.worldToCell(point.x), this.worldToCell(point.z));
  }

  nearestWalkable(x, z, maxRadius = 6) {
    if (this.isWalkableCell(x, z)) return { x, z };
    for (let radius = 1; radius <= maxRadius; radius += 1) {
      for (let dz = -radius; dz <= radius; dz += 1) {
        for (let dx = -radius; dx <= radius; dx += 1) {
          if (Math.abs(dx) !== radius && Math.abs(dz) !== radius) continue;
          const nx = x + dx;
          const nz = z + dz;
          if (this.isWalkableCell(nx, nz)) return { x: nx, z: nz };
        }
      }
    }
    return null;
  }

  findPath(start, goal, maxIterations = 2400) {
    const rawStart = { x: this.worldToCell(start.x), z: this.worldToCell(start.z) };
    const rawGoal = { x: this.worldToCell(goal.x), z: this.worldToCell(goal.z) };
    const startCell = this.nearestWalkable(rawStart.x, rawStart.z);
    const goalCell = this.nearestWalkable(rawGoal.x, rawGoal.z, 8);
    if (!startCell || !goalCell) return [];

    const startIndex = this.index(startCell.x, startCell.z);
    const goalIndex = this.index(goalCell.x, goalCell.z);
    if (startIndex === goalIndex) return [this.cellToWorld(goalCell.x, goalCell.z)];

    const total = this.size * this.size;
    const gScore = new Float32Array(total);
    const cameFrom = new Int32Array(total);
    const closed = new Uint8Array(total);
    gScore.fill(Infinity);
    cameFrom.fill(-1);
    gScore[startIndex] = 0;

    const open = new MinHeap();
    open.push(startIndex, this.heuristic(startCell, goalCell));
    let iterations = 0;
    let found = false;

    while (open.size && iterations < maxIterations) {
      iterations += 1;
      const currentIndex = open.pop();
      if (closed[currentIndex]) continue;
      closed[currentIndex] = 1;
      if (currentIndex === goalIndex) {
        found = true;
        break;
      }

      const currentX = currentIndex % this.size;
      const currentZ = Math.floor(currentIndex / this.size);
      for (let dz = -1; dz <= 1; dz += 1) {
        for (let dx = -1; dx <= 1; dx += 1) {
          if (dx === 0 && dz === 0) continue;
          const nextX = currentX + dx;
          const nextZ = currentZ + dz;
          if (!this.isWalkableCell(nextX, nextZ)) continue;
          if (dx !== 0 && dz !== 0) {
            if (this.blocked[this.index(currentX + dx, currentZ)] || this.blocked[this.index(currentX, currentZ + dz)]) continue;
          }
          const nextIndex = this.index(nextX, nextZ);
          if (closed[nextIndex]) continue;
          const movement = dx !== 0 && dz !== 0 ? 1.4142 : 1;
          const tentative = gScore[currentIndex] + movement;
          if (tentative >= gScore[nextIndex]) continue;
          cameFrom[nextIndex] = currentIndex;
          gScore[nextIndex] = tentative;
          open.push(nextIndex, tentative + this.heuristic({ x: nextX, z: nextZ }, goalCell));
        }
      }
    }

    if (!found) return [];
    const cells = [];
    let current = goalIndex;
    while (current !== -1 && cells.length < 180) {
      cells.push(current);
      if (current === startIndex) break;
      current = cameFrom[current];
    }
    cells.reverse();

    const points = [];
    for (let index = 1; index < cells.length; index += 1) {
      const cellIndex = cells[index];
      points.push(this.cellToWorld(cellIndex % this.size, Math.floor(cellIndex / this.size)));
    }
    if (points.length) points[points.length - 1].copy(this.cellToWorld(goalCell.x, goalCell.z));
    return points;
  }

  randomPointNear(center, minRadius, maxRadius, random = Math.random) {
    const angle = random() * Math.PI * 2;
    const radius = THREE.MathUtils.lerp(minRadius, maxRadius, Math.sqrt(random()));
    const x = center.x + Math.cos(angle) * radius;
    const z = center.z + Math.sin(angle) * radius;
    const cell = this.nearestWalkable(this.worldToCell(x), this.worldToCell(z), 5);
    return cell ? this.cellToWorld(cell.x, cell.z) : center.clone();
  }

  heuristic(a, b) {
    const dx = Math.abs(a.x - b.x);
    const dz = Math.abs(a.z - b.z);
    return Math.max(dx, dz) + 0.4142 * Math.min(dx, dz);
  }
}

class MinHeap {
  constructor() {
    this.items = [];
    this.priorities = [];
  }

  get size() {
    return this.items.length;
  }

  push(value, priority) {
    this.items.push(value);
    this.priorities.push(priority);
    let index = this.items.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.priorities[parent] <= this.priorities[index]) break;
      this.swap(parent, index);
      index = parent;
    }
  }

  pop() {
    if (!this.items.length) return undefined;
    const first = this.items[0];
    const lastValue = this.items.pop();
    const lastPriority = this.priorities.pop();
    if (this.items.length) {
      this.items[0] = lastValue;
      this.priorities[0] = lastPriority;
      this.sink(0);
    }
    return first;
  }

  sink(index) {
    while (true) {
      const left = index * 2 + 1;
      const right = left + 1;
      let smallest = index;
      if (left < this.items.length && this.priorities[left] < this.priorities[smallest]) smallest = left;
      if (right < this.items.length && this.priorities[right] < this.priorities[smallest]) smallest = right;
      if (smallest === index) break;
      this.swap(index, smallest);
      index = smallest;
    }
  }

  swap(a, b) {
    [this.items[a], this.items[b]] = [this.items[b], this.items[a]];
    [this.priorities[a], this.priorities[b]] = [this.priorities[b], this.priorities[a]];
  }
}

function arenaColliders(arena) {
  return arena.colliders;
}
