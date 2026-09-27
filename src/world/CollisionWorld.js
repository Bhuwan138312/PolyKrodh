import * as THREE from 'three';
import { MeshBVH, CENTER } from 'three-mesh-bvh';

const GRID_CELL = 4;
const CELL_KEY_OFFSET = 32768;
const CHUNK_TRIANGLE_LIMIT = 150000;
const MIN_EDGE_LENGTH = 0.02;
const MIN_TRIANGLE_AREA = 1e-7;
const EPSILON = 1e-6;
// The floor the body stands on sits exactly at the cylinder's lower bound, so a
// thin skin keeps the surface being stood on from counting as an obstacle.
const FLOOR_SKIN = 0.03;

function gridKey(cx, cz) {
  return (cx + CELL_KEY_OFFSET) * 65536 + (cz + CELL_KEY_OFFSET);
}

function edgeLengthSq(ax, ay, az, bx, by, bz) {
  const dx = ax - bx;
  const dy = ay - by;
  const dz = az - bz;
  return dx * dx + dy * dy + dz * dz;
}

function segmentDistanceSqXZ(px, pz, ax, az, bx, bz) {
  const vx = bx - ax;
  const vz = bz - az;
  const wx = px - ax;
  const wz = pz - az;
  const lengthSq = vx * vx + vz * vz;
  let t = 0;
  if (lengthSq > EPSILON) t = (wx * vx + wz * vz) / lengthSq;
  t = t < 0 ? 0 : (t > 1 ? 1 : t);
  const cx = ax + vx * t;
  const cz = az + vz * t;
  const dx = px - cx;
  const dz = pz - cz;
  return dx * dx + dz * dz;
}

/**
 * Squared distance from a point to a triangle projected onto the XZ plane.
 * Winding agnostic, which is what keeps collision stable no matter how a GLB
 * was exported.
 */
function pointTriangleDistanceSqXZ(px, pz, ax, az, bx, bz, cx, cz) {
  const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
  const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
  const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  if (!(hasNegative && hasPositive)) return 0;

  let best = segmentDistanceSqXZ(px, pz, ax, az, bx, bz);
  const second = segmentDistanceSqXZ(px, pz, bx, bz, cx, cz);
  if (second < best) best = second;
  const third = segmentDistanceSqXZ(px, pz, cx, cz, ax, az);
  if (third < best) best = third;
  return best;
}

/**
 * Squared distance between two 3D segments (Ericson, Real-Time Collision
 * Detection). Used to measure a vertical body axis against a wall edge without
 * over blocking on sloped surfaces.
 */
function segmentSegmentDistanceSq(
  p1x, p1y, p1z, q1x, q1y, q1z,
  p2x, p2y, p2z, q2x, q2y, q2z,
) {
  const d1x = q1x - p1x, d1y = q1y - p1y, d1z = q1z - p1z;
  const d2x = q2x - p2x, d2y = q2y - p2y, d2z = q2z - p2z;
  const rx = p1x - p2x, ry = p1y - p2y, rz = p1z - p2z;
  const a = d1x * d1x + d1y * d1y + d1z * d1z;
  const e = d2x * d2x + d2y * d2y + d2z * d2z;
  const f = d2x * rx + d2y * ry + d2z * rz;
  if (a <= EPSILON && e <= EPSILON) return rx * rx + ry * ry + rz * rz;

  let s = 0;
  let t = 0;
  if (a <= EPSILON) {
    t = e > EPSILON ? clamp01(f / e) : 0;
  } else {
    const c = d1x * rx + d1y * ry + d1z * rz;
    if (e <= EPSILON) {
      s = clamp01(-c / a);
    } else {
      const b = d1x * d2x + d1y * d2y + d1z * d2z;
      const denominator = a * e - b * b;
      s = denominator !== 0 ? clamp01((b * f - c * e) / denominator) : 0;
      t = (b * s + f) / e;
      if (t < 0) {
        t = 0;
        s = clamp01(-c / a);
      } else if (t > 1) {
        t = 1;
        s = clamp01((b - c) / a);
      }
    }
  }
  const c1x = p1x + d1x * s, c1y = p1y + d1y * s, c1z = p1z + d1z * s;
  const c2x = p2x + d2x * t, c2y = p2y + d2y * t, c2z = p2z + d2z * t;
  const dx = c1x - c2x, dy = c1y - c2y, dz = c1z - c2z;
  return dx * dx + dy * dy + dz * dz;
}

function clamp01(value) {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** True when the vertical axis passes straight through the triangle surface. */
function axisCrossesTriangleXZ(x, z, ax, az, bx, bz, cx, cz) {
  const d1 = (x - bx) * (az - bz) - (ax - bx) * (z - bz);
  const d2 = (x - cx) * (bz - cz) - (bx - cx) * (z - cz);
  const d3 = (x - ax) * (cz - az) - (cx - ax) * (z - az);
  const hasNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const hasPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(hasNegative && hasPositive);
}

/**
 * Exact overlap test between a vertical cylinder and a triangle.
 *
 * The XZ projection is used as a cheap conservative reject, then the true 3D
 * distance to each edge decides. Without that second step a sloped roof passing
 * five metres overhead would read as a wall right in front of the body.
 */
function cylinderOverlapsTriangle(x, yBottom, yTop, z, radiusSq, tri) {
  const y0 = tri.a.y, y1 = tri.b.y, y2 = tri.c.y;
  const triMaxY = y0 > y1 ? (y0 > y2 ? y0 : y2) : (y1 > y2 ? y1 : y2);
  if (triMaxY < yBottom) return false;
  const triMinY = y0 < y1 ? (y0 < y2 ? y0 : y2) : (y1 < y2 ? y1 : y2);
  if (triMinY > yTop) return false;

  const ax = tri.a.x, az = tri.a.z;
  const bx = tri.b.x, bz = tri.b.z;
  const cx = tri.c.x, cz = tri.c.z;

  const nx = (y1 - y0) * (cz - az) - (bz - az) * (y2 - y0);
  const nz = (bx - ax) * (y2 - y0) - (y1 - y0) * (cx - ax);
  const ny = (bz - az) * (cx - ax) - (bx - ax) * (cz - az);
  
  if (Math.abs(ny) > 1e-6) {
    const yCenter = y0 - (nx * (x - ax) + nz * (z - az)) / ny;
    const ySpread = Math.sqrt(radiusSq * (nx * nx + nz * nz)) / Math.abs(ny);
    if (yCenter + ySpread < yBottom) return false;
    if (yCenter - ySpread > yTop) return false;
  }

  if (axisCrossesTriangleXZ(x, z, ax, az, bx, bz, cx, cz)) return true;
  if (pointTriangleDistanceSqXZ(x, z, ax, az, bx, bz, cx, cz) >= radiusSq) return false;

  if (segmentSegmentDistanceSq(x, yBottom, z, x, yTop, z, ax, y0, az, bx, y1, bz) < radiusSq) return true;
  if (segmentSegmentDistanceSq(x, yBottom, z, x, yTop, z, bx, y1, bz, cx, y2, cz) < radiusSq) return true;
  if (segmentSegmentDistanceSq(x, yBottom, z, x, yTop, z, cx, y2, cz, ax, y0, az) < radiusSq) return true;

  // Fix for vertical walls: if the triangle is vertical, the XZ axis cross test fails,
  // and the edges might be further than radius. But if it passed the XZ footprint test 
  // and Y bounds test above, the cylinder is penetrating the flat face of the wall!
  if (ny * ny < (nx * nx + nz * nz) * 0.001) return true;

  return false;
}

const SOLIDITY_AXES = [
  [1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1],
];

/**
 * Static, triangle accurate collision world baked from the arena geometry.
 *
 * The map is flattened into world space, split into a few BVHs and indexed by a
 * uniform grid, so a query only visits chunks that can matter. Every test is
 * analytic and winding agnostic, which is what makes doorways walkable, walls
 * solid from either side (including from the inside) and bullets unable to
 * escape through geometry.
 */
export class CollisionWorld {
  constructor() {
    this.chunks = [];
    this.grid = new Map();
    this.ready = false;
    this.triangleCount = 0;
    this.sourceTriangles = 0;
    this.droppedTriangles = 0;
    this.floorY = 0;
    this.bounds = new THREE.Box3().makeEmpty();

    this._positions = new Float32Array(0);
    this._vertexCount = 0;
    this._stamps = new Int32Array(0);
    this._tick = 0;
    this._candidates = [];
    this._rootInverse = new THREE.Matrix4();
    this._matrix = new THREE.Matrix4();
    this._rayOrigin = new THREE.Vector3();
    this._rayDirection = new THREE.Vector3();
    this._normal = new THREE.Vector3();
    this._point = new THREE.Vector3();
  }

  // ------------------------------------------------------------------- building

  begin(rootInverse = null) {
    this._positions = new Float32Array(9 * 8192);
    this._vertexCount = 0;
    this._sourceTriangles = 0;
    this.droppedTriangles = 0;
    this.chunks.length = 0;
    this.grid.clear();
    this.bounds.makeEmpty();
    this.ready = false;
    this._rootInverse.copy(rootInverse ?? IDENTITY_MATRIX);
    return this;
  }

  addMesh(mesh) {
    const geometry = mesh?.geometry;
    const position = geometry?.attributes?.position;
    if (!position) return 0;
    this._matrix.copy(this._rootInverse).multiply(mesh.matrixWorld);
    const e = this._matrix.elements;

    const index = geometry.index;
    const sourceCount = index ? index.count : position.count;
    const array = position.array;
    let added = 0;

    for (let i = 0; i < sourceCount; i += 3) {
      const i0 = index ? index.getX(i) : i;
      const i1 = index ? index.getX(i + 1) : i + 1;
      const i2 = index ? index.getX(i + 2) : i + 2;
      this._sourceTriangles += 1;

      const ax = array[i0 * 3];
      const ay = array[i0 * 3 + 1];
      const az = array[i0 * 3 + 2];
      const bx = array[i1 * 3];
      const by = array[i1 * 3 + 1];
      const bz = array[i1 * 3 + 2];
      const cx = array[i2 * 3];
      const cy = array[i2 * 3 + 1];
      const cz = array[i2 * 3 + 2];

      const wax = e[0] * ax + e[4] * ay + e[8] * az + e[12];
      const way = e[1] * ax + e[5] * ay + e[9] * az + e[13];
      const waz = e[2] * ax + e[6] * ay + e[10] * az + e[14];
      const wbx = e[0] * bx + e[4] * by + e[8] * bz + e[12];
      const wby = e[1] * bx + e[5] * by + e[9] * bz + e[13];
      const wbz = e[2] * bx + e[6] * by + e[10] * bz + e[14];
      const wcx = e[0] * cx + e[4] * cy + e[8] * cz + e[12];
      const wcy = e[1] * cx + e[5] * cy + e[9] * cz + e[13];
      const wcz = e[2] * cx + e[6] * cy + e[10] * cz + e[14];

      // Drop micro detail (lamp trim, window mullions, sign lettering): tens of
      // thousands of triangles that could never stop a body or a bullet.
      const longestSq = Math.max(
        edgeLengthSq(wax, way, waz, wbx, wby, wbz),
        edgeLengthSq(wbx, wby, wbz, wcx, wcy, wcz),
        edgeLengthSq(wcx, wcy, wcz, wax, way, waz),
      );
      if (longestSq < MIN_EDGE_LENGTH * MIN_EDGE_LENGTH) {
        this.droppedTriangles += 1;
        continue;
      }
      // Reject zero-area slivers. Uses the full cross product so horizontal
      // faces (where the Y component is zero) survive.
      const e1x = wbx - wax, e1y = wby - way, e1z = wbz - waz;
      const e2x = wcx - wax, e2y = wcy - way, e2z = wcz - waz;
      const nx = e1y * e2z - e1z * e2y;
      const ny = e1z * e2x - e1x * e2z;
      const nz = e1x * e2y - e1y * e2x;
      if (nx * nx + ny * ny + nz * nz < MIN_TRIANGLE_AREA * MIN_TRIANGLE_AREA) {
        this.droppedTriangles += 1;
        continue;
      }

      this._pushVertex(wax, way, waz);
      this._pushVertex(wbx, wby, wbz);
      this._pushVertex(wcx, wcy, wcz);
      added += 1;
    }
    return added;
  }

  _pushVertex(x, y, z) {
    if (this._vertexCount + 3 > this._positions.length) {
      const grown = new Float32Array(this._positions.length * 2);
      grown.set(this._positions);
      this._positions = grown;
    }
    const offset = this._vertexCount;
    this._positions[offset] = x;
    this._positions[offset + 1] = y;
    this._positions[offset + 2] = z;
    this._vertexCount = offset + 3;
  }

  finalize() {
    const triangleCount = Math.floor(this._vertexCount / 9);
    this.triangleCount = triangleCount;
    this.bounds.makeEmpty();

    for (let start = 0; start < triangleCount; start += CHUNK_TRIANGLE_LIMIT) {
      const end = Math.min(triangleCount, start + CHUNK_TRIANGLE_LIMIT);
      const count = end - start;
      const geometry = new THREE.BufferGeometry();
      // Deliberately non indexed: three-mesh-bvh derives its primitive count from
      // `index.count / 3`, so an explicit sequential index would make it treat
      // three quarters of the chunk as out of range. `ensureIndex` builds the
      // correct one from `position.count` (three vertices per triangle) instead.
      geometry.setAttribute(
        'position',
        new THREE.BufferAttribute(this._positions.subarray(start * 9, end * 9), 3),
      );
      geometry.computeBoundingBox();
      geometry.computeBoundingSphere();
      geometry.boundsTree = new MeshBVH(geometry, { strategy: CENTER, targetLeafSize: 10 });
      this.chunks.push({
        bounds: geometry.boundingBox,
        bvh: geometry.boundsTree,
        triangles: count,
      });
      this.bounds.union(geometry.boundingBox);
    }

    this._stamps = new Int32Array(this.chunks.length);
    this._tick = 0;
    this._buildGrid();
    this.ready = this.chunks.length > 0;
    this.sourceTriangles = this._sourceTriangles;
    if (this.ready) this.floorY = this._probeFloor();
    this._positions = new Float32Array(0);
    this._vertexCount = 0;
    return this;
  }

  /**
   * Best guess at the arena's base floor, sampled from a coarse grid so a lone
   * rooftop cannot be mistaken for the ground.
   */
  _probeFloor() {
    const centreX = (this.bounds.min.x + this.bounds.max.x) * 0.5;
    const centreZ = (this.bounds.min.z + this.bounds.max.z) * 0.5;
    const top = this.bounds.max.y + 1;
    const span = top - (this.bounds.min.y - 4);
    const samples = [];
    for (let ix = -2; ix <= 2; ix += 1) {
      for (let iz = -2; iz <= 2; iz += 1) {
        const x = centreX + (ix / 2) * (this.bounds.max.x - this.bounds.min.x) * 0.35;
        const z = centreZ + (iz / 2) * (this.bounds.max.z - this.bounds.min.z) * 0.35;
        const hit = this.raycast(this._point.set(x, top, z), DOWN, span);
        if (hit) samples.push(hit.point.y);
      }
    }
    if (samples.length === 0) return 0;
    samples.sort((a, b) => a - b);
    return samples[Math.floor(samples.length / 2)];
  }

  _buildGrid() {
    this.grid.clear();
    const inverse = 1 / GRID_CELL;
    for (let i = 0; i < this.chunks.length; i += 1) {
      const bounds = this.chunks[i].bounds;
      const minX = Math.floor(bounds.min.x * inverse);
      const maxX = Math.floor(bounds.max.x * inverse);
      const minZ = Math.floor(bounds.min.z * inverse);
      const maxZ = Math.floor(bounds.max.z * inverse);
      for (let cx = minX; cx <= maxX; cx += 1) {
        for (let cz = minZ; cz <= maxZ; cz += 1) {
          const key = gridKey(cx, cz);
          let bucket = this.grid.get(key);
          if (!bucket) {
            bucket = [];
            this.grid.set(key, bucket);
          }
          bucket.push(i);
        }
      }
    }
  }

  // ----------------------------------------------------------------- broadphase

  _collectChunks(minX, minY, minZ, maxX, maxY, maxZ) {
    const candidates = this._candidates;
    candidates.length = 0;
    if (this.chunks.length === 0) return candidates;
    this._tick += 1;
    const tick = this._tick;
    const inverse = 1 / GRID_CELL;
    const minCX = Math.floor(minX * inverse);
    const maxCX = Math.floor(maxX * inverse);
    const minCZ = Math.floor(minZ * inverse);
    const maxCZ = Math.floor(maxZ * inverse);
    for (let cx = minCX; cx <= maxCX; cx += 1) {
      for (let cz = minCZ; cz <= maxCZ; cz += 1) {
        const bucket = this.grid.get(gridKey(cx, cz));
        if (!bucket) continue;
        for (let i = 0; i < bucket.length; i += 1) {
          const index = bucket[i];
          if (this._stamps[index] === tick) continue;
          this._stamps[index] = tick;
          const bounds = this.chunks[index].bounds;
          if (bounds.max.x < minX || bounds.min.x > maxX) continue;
          if (bounds.max.y < minY || bounds.min.y > maxY) continue;
          if (bounds.max.z < minZ || bounds.min.z > maxZ) continue;
          candidates.push(index);
        }
      }
    }
    return candidates;
  }

  // -------------------------------------------------------------------- queries

  /**
   * True when a vertical cylinder overlaps solid map geometry.
   * `stepTolerance` raises the bottom of the cylinder so low props turn into
   * walk-on surfaces instead of walls.
   */
  overlapsCylinder(x, z, yBottom, yTop, radius, stepTolerance = 0) {
    if (!this.ready) return false;
    const lower = yBottom + stepTolerance + FLOOR_SKIN;
    const upper = yTop;
    if (upper <= lower) return false;
    const radiusSq = radius * radius;
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;
    const candidates = this._collectChunks(minX, lower, minZ, maxX, upper, maxZ);
    if (candidates.length === 0) return false;

    for (let c = 0; c < candidates.length; c += 1) {
      const chunk = this.chunks[candidates[c]];
      const bounds = chunk.bounds;
      if (bounds.max.x < minX || bounds.min.x > maxX) continue;
      if (bounds.max.y < lower || bounds.min.y > upper) continue;
      if (bounds.max.z < minZ || bounds.min.z > maxZ) continue;
      let blocked = false;
      chunk.bvh.shapecast({
        intersectsBounds: (nodeBox) => (
          nodeBox.max.x >= minX && nodeBox.min.x <= maxX
          && nodeBox.max.y >= lower && nodeBox.min.y <= upper
          && nodeBox.max.z >= minZ && nodeBox.min.z <= maxZ
        ),
        intersectsTriangle: (triangle) => {
          if (cylinderOverlapsTriangle(x, lower, upper, z, radiusSq, triangle)) blocked = true;
        },
      });
      if (blocked) return true;
    }
    return false;
  }

  /**
   * Continuous-ish exact capsule collision.
   * Returns an array of penetrations: { depth, normal, point }
   */
  collideCapsule(capsuleLine, radius) {
    if (!this.ready) return [];
    
    const penetrations = [];
    const minX = Math.min(capsuleLine.start.x, capsuleLine.end.x) - radius;
    const maxX = Math.max(capsuleLine.start.x, capsuleLine.end.x) + radius;
    const minY = Math.min(capsuleLine.start.y, capsuleLine.end.y) - radius;
    const maxY = Math.max(capsuleLine.start.y, capsuleLine.end.y) + radius;
    const minZ = Math.min(capsuleLine.start.z, capsuleLine.end.z) - radius;
    const maxZ = Math.max(capsuleLine.start.z, capsuleLine.end.z) + radius;

    const candidates = this._collectChunks(minX, minY, minZ, maxX, maxY, maxZ);
    if (candidates.length === 0) return penetrations;

    const triPoint = new THREE.Vector3();
    const capPoint = new THREE.Vector3();

    for (let c = 0; c < candidates.length; c += 1) {
      const chunk = this.chunks[candidates[c]];
      const bounds = chunk.bounds;
      if (bounds.max.x < minX || bounds.min.x > maxX) continue;
      if (bounds.max.y < minY || bounds.min.y > maxY) continue;
      if (bounds.max.z < minZ || bounds.min.z > maxZ) continue;
      
      chunk.bvh.shapecast({
        intersectsBounds: (nodeBox) => (
          nodeBox.max.x >= minX && nodeBox.min.x <= maxX
          && nodeBox.max.y >= minY && nodeBox.min.y <= maxY
          && nodeBox.max.z >= minZ && nodeBox.min.z <= maxZ
        ),
        intersectsTriangle: (triangle) => {
          const distance = triangle.closestPointToSegment(capsuleLine, triPoint, capPoint);
          if (distance < radius && distance > 1e-7) {
             const depth = radius - distance;
             const normal = capPoint.clone().sub(triPoint).normalize();
             penetrations.push({ depth, normal, point: triPoint.clone() });
          } else if (distance <= 1e-7) {
             // Deep penetration / exact intersection. Handle fallback.
             penetrations.push({ depth: radius, normal: new THREE.Vector3(0, 1, 0), point: triPoint.clone() });
          }
        },
      });
    }
    return penetrations;
  }

  /**
   * Highest solid surface at or below `fromY`, searched over a small disc so the
   * body never slips through the seams between adjacent triangles.
   */
  groundHeight(x, z, radius, fromY, maxDrop) {
    if (!this.ready) return -Infinity;
    const lowest = fromY - maxDrop;
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;
    const candidates = this._collectChunks(minX, lowest, minZ, maxX, fromY, maxZ);
    if (candidates.length === 0) return -Infinity;

    let best = -Infinity;
    for (let c = 0; c < candidates.length; c += 1) {
      const chunk = this.chunks[candidates[c]];
      chunk.bvh.shapecast({
        intersectsBounds: (nodeBox) => (
          nodeBox.max.x >= minX && nodeBox.min.x <= maxX
          && nodeBox.max.z >= minZ && nodeBox.min.z <= maxZ
          && nodeBox.max.y >= lowest && nodeBox.min.y <= fromY
        ),
        intersectsTriangle: (triangle) => {
          const y = verticalHit(triangle, x, z, fromY, lowest, true);
          if (y !== null && y > best) best = y;
        },
      });
    }
    return best;
  }

  /** Lowest solid surface above `fromY`, or Infinity when the sky is clear. */
  ceilingHeight(x, z, radius, fromY, maxRise) {
    if (!this.ready) return Infinity;
    const highest = fromY + maxRise;
    const minX = x - radius;
    const maxX = x + radius;
    const minZ = z - radius;
    const maxZ = z + radius;
    const candidates = this._collectChunks(minX, fromY - 0.05, minZ, maxX, highest, maxZ);
    if (candidates.length === 0) return Infinity;

    let best = Infinity;
    for (let c = 0; c < candidates.length; c += 1) {
      const chunk = this.chunks[candidates[c]];
      chunk.bvh.shapecast({
        intersectsBounds: (nodeBox) => (
          nodeBox.max.x >= minX && nodeBox.min.x <= maxX
          && nodeBox.max.z >= minZ && nodeBox.min.z <= maxZ
          && nodeBox.max.y >= fromY && nodeBox.min.y <= highest
        ),
        intersectsTriangle: (triangle) => {
          const y = verticalHit(triangle, x, z, fromY, highest, false);
          if (y !== null && y < best) best = y;
        },
      });
    }
    return best;
  }

  /**
   * Closest solid surface along a ray. Double sided on purpose: a bullet that
   * starts inside a wall still stops on that wall instead of tunnelling out.
   */
  raycast(origin, direction, far = Infinity) {
    if (!this.ready) return null;
    const ox = origin.x;
    const oy = origin.y;
    const oz = origin.z;
    const length = direction.length();
    if (length < 1e-9) return null;
    const dx = direction.x / length;
    const dy = direction.y / length;
    const dz = direction.z / length;
    const endX = ox + dx * far;
    const endY = oy + dy * far;
    const endZ = oz + dz * far;

    const candidates = this._collectChunks(
      Math.min(ox, endX), Math.min(oy, endY), Math.min(oz, endZ),
      Math.max(ox, endX), Math.max(oy, endY), Math.max(oz, endZ),
    );
    if (candidates.length === 0) return null;

    const normal = this._normal;
    let bestDistance = far;
    let hitNormal = null;
    for (let c = 0; c < candidates.length; c += 1) {
      const chunk = this.chunks[candidates[c]];
      chunk.bvh.shapecast({
        intersectsBounds: (nodeBox) => rayIntersectsBox(nodeBox, ox, oy, oz, dx, dy, dz, bestDistance),
        intersectsTriangle: (triangle) => {
          const distance = rayTriangle(ox, oy, oz, dx, dy, dz, triangle, bestDistance, normal);
          if (distance !== null && distance < bestDistance) {
            bestDistance = distance;
            if (!hitNormal) hitNormal = new THREE.Vector3();
            hitNormal.copy(normal);
          }
        },
      });
    }

    if (!hitNormal) return null;
    return {
      distance: bestDistance,
      point: new THREE.Vector3(ox + dx * bestDistance, oy + dy * bestDistance, oz + dz * bestDistance),
      normal: hitNormal,
    };
  }

  /** True when the point is enclosed by solid geometry. Used by diagnostics. */
  isInsideSolid(point) {
    if (!this.ready) return false;
    let closed = 0;
    for (let i = 0; i < SOLIDITY_AXES.length; i += 1) {
      const axis = SOLIDITY_AXES[i];
      this._rayDirection.set(axis[0], axis[1], axis[2]);
      if (this.raycast(point, this._rayDirection, 2.5)) closed += 1;
    }
    return closed >= 5;
  }
}

const IDENTITY_MATRIX = new THREE.Matrix4();
const DOWN = new THREE.Vector3(0, -1, 0);

function rayIntersectsBox(box, ox, oy, oz, dx, dy, dz, maxDistance) {
  let tmin = 0;
  let tmax = maxDistance;
  if (Math.abs(dx) < 1e-9) {
    if (ox < box.min.x || ox > box.max.x) return false;
  } else {
    const inverse = 1 / dx;
    let t1 = (box.min.x - ox) * inverse;
    let t2 = (box.max.x - ox) * inverse;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < box.min.y || oy > box.max.y) return false;
  } else {
    const inverse = 1 / dy;
    let t1 = (box.min.y - oy) * inverse;
    let t2 = (box.max.y - oy) * inverse;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  if (Math.abs(dz) < 1e-9) {
    if (oz < box.min.z || oz > box.max.z) return false;
  } else {
    const inverse = 1 / dz;
    let t1 = (box.min.z - oz) * inverse;
    let t2 = (box.max.z - oz) * inverse;
    if (t1 > t2) { const swap = t1; t1 = t2; t2 = swap; }
    if (t1 > tmin) tmin = t1;
    if (t2 < tmax) tmax = t2;
    if (tmin > tmax) return false;
  }
  return true;
}

function rayTriangle(ox, oy, oz, dx, dy, dz, triangle, maxDistance, normalOut) {
  const ax = triangle.a.x;
  const ay = triangle.a.y;
  const az = triangle.a.z;
  const e1x = triangle.b.x - ax;
  const e1y = triangle.b.y - ay;
  const e1z = triangle.b.z - az;
  const e2x = triangle.c.x - ax;
  const e2y = triangle.c.y - ay;
  const e2z = triangle.c.z - az;

  const px = dy * e2z - dz * e2y;
  const py = dz * e2x - dx * e2z;
  const pz = dx * e2y - dy * e2x;
  const determinant = e1x * px + e1y * py + e1z * pz;
  if (Math.abs(determinant) < 1e-12) return null;
  const inverse = 1 / determinant;

  const tx = ox - ax;
  const ty = oy - ay;
  const tz = oz - az;
  const u = (tx * px + ty * py + tz * pz) * inverse;
  if (u < -1e-6 || u > 1 + 1e-6) return null;

  const qx = ty * e1z - tz * e1y;
  const qy = tz * e1x - tx * e1z;
  const qz = tx * e1y - ty * e1x;
  const v = (dx * qx + dy * qy + dz * qz) * inverse;
  if (v < -1e-6 || u + v > 1 + 1e-6) return null;

  const distance = (e2x * qx + e2y * qy + e2z * qz) * inverse;
  if (distance < 1e-4 || distance > maxDistance) return null;

  normalOut.set(e1y * e2z - e1z * e2y, e1z * e2x - e1x * e2z, e1x * e2y - e1y * e2x);
  const magnitude = normalOut.length();
  if (magnitude > 1e-12) normalOut.multiplyScalar(1 / magnitude);
  else normalOut.set(0, 1, 0);
  return distance;
}

/**
 * Height at which a vertical ray through (x, z) crosses the triangle, or null.
 * A triangle is a single surface, so the hit height is the same from either
 * side: no winding test is applied, which keeps upside down exports working.
 */
function verticalHit(triangle, x, z, fromY, limitY, downward) {
  const ax = triangle.a.x;
  const ay = triangle.a.y;
  const az = triangle.a.z;
  const e1x = triangle.b.x - ax;
  const e1y = triangle.b.y - ay;
  const e1z = triangle.b.z - az;
  const e2x = triangle.c.x - ax;
  const e2y = triangle.c.y - ay;
  const e2z = triangle.c.z - az;

  const nx = e1y * e2z - e1z * e2y;
  const ny = e1z * e2x - e1x * e2z;
  const nz = e1x * e2y - e1y * e2x;
  if (Math.abs(ny) < 1e-9) return null; // vertical surface, cannot be stood on

  const y = ay - (nx * (x - ax) + nz * (z - az)) / ny;
  if (!Number.isFinite(y)) return null;
  if (downward) {
    if (y > fromY + 1e-4 || y < limitY) return null;
  } else if (y < fromY - 1e-4 || y > limitY) {
    return null;
  }

  // The crossing point has to land inside the triangle footprint.
  const vx = triangle.b.x - ax;
  const vz = triangle.b.z - az;
  const wx = triangle.c.x - ax;
  const wz = triangle.c.z - az;
  const px = x - ax;
  const pz = z - az;
  const dot00 = vx * vx + vz * vz;
  const dot01 = vx * wx + vz * wz;
  const dot11 = wx * wx + wz * wz;
  const dot20 = px * vx + pz * vz;
  const dot21 = px * wx + pz * wz;
  const denominator = dot00 * dot11 - dot01 * dot01;
  if (Math.abs(denominator) > 1e-12) {
    const inverse = 1 / denominator;
    const u = (dot11 * dot20 - dot01 * dot21) * inverse;
    const v = (dot00 * dot21 - dot01 * dot20) * inverse;
    if (u < -1e-5 || v < -1e-5 || u + v > 1 + 1e-5) return null;
  } else if (pointTriangleDistanceSqXZ(x, z, ax, az, triangle.b.x, triangle.b.z, triangle.c.x, triangle.c.z) > 1e-10) {
    return null;
  }
  return y;
}
