import type { Vec3 } from '../../shared/protocol.js';

export interface Wall { min: Vec3; max: Vec3 }
export interface Terminal { serverId: number; pos: Vec3 }

export interface GameMap {
  size: number;
  walls: Wall[];
  terminals: Terminal[];
  spawns: { red: Vec3[]; blue: Vec3[] };
}

export function makeMap(): GameMap {
  const S = 40;
  const w = (x0: number, z0: number, x1: number, z1: number, h = 3): Wall => ({
    min: { x: x0, y: 0, z: z0 },
    max: { x: x1, y: h, z: z1 },
  });
  return {
    size: S,
    walls: [
      w(-S / 2, -S / 2, S / 2, -S / 2 + 1),
      w(-S / 2, S / 2 - 1, S / 2, S / 2),
      w(-S / 2, -S / 2, -S / 2 + 1, S / 2),
      w(S / 2 - 1, -S / 2, S / 2, S / 2),
      w(-6, -4, -1, -3),
      w(-6, 3, -1, 4),
      w(1, -4, 6, -3),
      w(1, 3, 6, 4),
      w(-1, -1, 1, 1),
    ],
    terminals: [
      { serverId: 0, pos: { x: -12, y: 0, z: 0 } },
      { serverId: 1, pos: { x: 12, y: 0, z: 0 } },
    ],
    spawns: {
      red: [
        { x: -16, y: 0, z: 14 },
        { x: -14, y: 0, z: 16 },
        { x: -18, y: 0, z: 16 },
      ],
      blue: [
        { x: 16, y: 0, z: -14 },
        { x: 14, y: 0, z: -16 },
        { x: 18, y: 0, z: -16 },
      ],
    },
  };
}

export function pointInWall(p: Vec3, wall: Wall, radius: number): boolean {
  return (
    p.x >= wall.min.x - radius && p.x <= wall.max.x + radius &&
    p.z >= wall.min.z - radius && p.z <= wall.max.z + radius
  );
}

export function collide(pos: Vec3, map: GameMap, radius: number): Vec3 {
  const lim = map.size / 2 - radius - 0.5;
  const clamped = { ...pos };
  clamped.x = Math.max(-lim, Math.min(lim, clamped.x));
  clamped.z = Math.max(-lim, Math.min(lim, clamped.z));
  for (const wall of map.walls) {
    if (clamped.y > wall.max.y) continue;
    if (pointInWall(clamped, wall, radius)) {
      const dxMin = Math.abs(clamped.x - (wall.min.x - radius));
      const dxMax = Math.abs(wall.max.x + radius - clamped.x);
      const dzMin = Math.abs(clamped.z - (wall.min.z - radius));
      const dzMax = Math.abs(wall.max.z + radius - clamped.z);
      const m = Math.min(dxMin, dxMax, dzMin, dzMax);
      if (m === dxMin) clamped.x = wall.min.x - radius;
      else if (m === dxMax) clamped.x = wall.max.x + radius;
      else if (m === dzMin) clamped.z = wall.min.z - radius;
      else clamped.z = wall.max.z + radius;
    }
  }
  return clamped;
}

export interface RayHit { t: number; point: Vec3; kind: 'wall' | 'player'; playerId?: number }

export function raycast(origin: Vec3, dir: Vec3, map: GameMap, maxDist: number): RayHit | null {
  let best: RayHit | null = null;
  let bestT = maxDist;

  for (const wall of map.walls) {
    const t = raySlab(origin, dir, wall, bestT);
    if (t !== null && t < bestT && t >= 0) {
      bestT = t;
      best = { t, point: add(origin, scale(dir, t)), kind: 'wall' };
    }
  }
  return best;
}

export function raySlab(origin: Vec3, dir: Vec3, wall: Wall, maxT: number): number | null {
  let tmin = 0;
  let tmax = maxT;
  const o = [origin.x, origin.y, origin.z];
  const d = [dir.x, dir.y, dir.z];
  const mn = [wall.min.x, wall.min.y, wall.min.z];
  const mx = [wall.max.x, wall.max.y, wall.max.z];
  for (let i = 0; i < 3; i++) {
    if (Math.abs(d[i]) < 1e-9) {
      if (o[i] < mn[i] || o[i] > mx[i]) return null;
    } else {
      let t1 = (mn[i] - o[i]) / d[i];
      let t2 = (mx[i] - o[i]) / d[i];
      if (t1 > t2) [t1, t2] = [t2, t1];
      tmin = Math.max(tmin, t1);
      tmax = Math.min(tmax, t2);
      if (tmin > tmax) return null;
    }
  }
  return tmin;
}

export function add(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x + b.x, y: a.y + b.y, z: a.z + b.z };
}

export function scale(a: Vec3, s: number): Vec3 {
  return { x: a.x * s, y: a.y * s, z: a.z * s };
}

export function sub(a: Vec3, b: Vec3): Vec3 {
  return { x: a.x - b.x, y: a.y - b.y, z: a.z - b.z };
}

export function len(a: Vec3): number {
  return Math.sqrt(a.x * a.x + a.y * a.y + a.z * a.z);
}

export function norm(a: Vec3): Vec3 {
  const l = len(a) || 1;
  return { x: a.x / l, y: a.y / l, z: a.z / l };
}

export function dist(a: Vec3, b: Vec3): number {
  return len(sub(a, b));
}
