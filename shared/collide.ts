// Static world colliders + sphere collision + raycasts. Used by client physics
// and by the server for PvP hit-scan line-of-sight.
import { dsin, dcos, hyp2, hyp3 } from './dmath.ts';
import { type V3, sub, dot, len, norm } from './math.ts';
import { type MapData, type Line, type Heightfield, bakeHeightfield, heightAt, groundAt, normalAt, courseLines, CEILING } from './map.ts';

type Collider =
  | { k: 'obb'; c: V3; h: V3; cs: number; sn: number; bc: V3; br: number }
  | { k: 'cyl'; c: V3; rad: number; y0: number; y1: number; bc: V3; br: number }
  | { k: 'sph'; c: V3; rad: number; bc: V3; br: number }
  | { k: 'tor'; c: V3; R: number; r: number; cs: number; sn: number; bc: V3; br: number };

export interface World {
  map: MapData;
  hf: Heightfield;
  colliders: Collider[];
  grid: Map<number, number[]>; // broadphase: cell key -> collider indices (ascending)
  stamp: Uint32Array;
  stampN: number;
}

const GRID = 16;
const cellKey = (i: number, j: number) => (i + 4096) * 8192 + (j + 4096);

const obb = (c: V3, size: V3, yaw: number): Collider => {
  const h: V3 = [size[0] / 2, size[1] / 2, size[2] / 2];
  return { k: 'obb', c, h, cs: dcos(yaw), sn: dsin(yaw), bc: c, br: len(h) };
};
const cyl = (base: V3, rad: number, hgt: number): Collider => ({
  k: 'cyl', c: base, rad, y0: base[1], y1: base[1] + hgt,
  bc: [base[0], base[1] + hgt / 2, base[2]], br: hyp2(rad, hgt / 2),
});

export const FRAME = 0.5; // thickness of start/checkpoint frame bars

/** Frame bars of a line: two posts and a top bar, plus a post down to the ground so frames never float. */
export function lineBars(l: Line, hf?: Heightfield): { c: V3; s: V3 }[] {
  const right: V3 = [dcos(l.r), 0, -dsin(l.r)];
  const top = l.p[1] + l.h / 2;
  const out: { c: V3; s: V3 }[] = [];
  for (const side of [-1, 1]) {
    const x = l.p[0] + right[0] * side * (l.w / 2 + FRAME / 2);
    const z = l.p[2] + right[2] * side * (l.w / 2 + FRAME / 2);
    const g = hf ? heightAt(hf, x, z) - 1 : l.p[1] - l.h / 2;
    const bottom = Math.min(g, l.p[1] - l.h / 2);
    out.push({ c: [x, (top + bottom) / 2, z], s: [FRAME, top - bottom + FRAME, FRAME] });
  }
  out.push({ c: [l.p[0], top + FRAME / 2, l.p[2]], s: [l.w + FRAME * 2, FRAME, FRAME] });
  return out;
}

export function buildWorld(map: MapData): World {
  const hf = bakeHeightfield(map);
  const colliders: Collider[] = [];
  for (const o of map.objects) {
    const [sx, sy, sz] = o.s;
    switch (o.t) {
      case 'box':
      case 'pad':
        colliders.push(obb([o.p[0], o.p[1] + sy / 2, o.p[2]], o.s, o.r));
        break;
      case 'cyl':
        colliders.push(cyl(o.p, sx / 2, sy));
        break;
      case 'tree':
        colliders.push(cyl(o.p, Math.max(0.25, sx * 0.08), sy));
        colliders.push(cyl([o.p[0], o.p[1] + sy * 0.3, o.p[2]], sx * 0.42, sy * 0.65));
        break;
      case 'rock': {
        const r = sx / 2;
        colliders.push({ k: 'sph', c: [o.p[0], o.p[1] + r * 0.5, o.p[2]], rad: r, bc: [o.p[0], o.p[1] + r * 0.5, o.p[2]], br: r });
        break;
      }
      case 'ring': {
        const R = sx / 2, r = Math.max(0.2, sz * 0.08);
        colliders.push({ k: 'tor', c: o.p, R, r, cs: dcos(o.r), sn: dsin(o.r), bc: o.p, br: R + r });
        break;
      }
    }
  }
  for (const l of courseLines(map)) for (const b of lineBars(l, hf)) colliders.push(obb(b.c, b.s, l.r));
  const grid = new Map<number, number[]>();
  colliders.forEach((c, idx) => {
    const i0 = Math.floor((c.bc[0] - c.br) / GRID), i1 = Math.floor((c.bc[0] + c.br) / GRID);
    const j0 = Math.floor((c.bc[2] - c.br) / GRID), j1 = Math.floor((c.bc[2] + c.br) / GRID);
    for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
      const k = cellKey(i, j);
      const list = grid.get(k);
      if (list) list.push(idx); else grid.set(k, [idx]);
    }
  });
  return { map, hf, colliders, grid, stamp: new Uint32Array(colliders.length), stampN: 0 };
}

/** Collider indices whose cells touch the sphere, in ascending order (determinism). */
function nearby(w: World, p: V3, r: number): number[] {
  const out: number[] = [];
  const n = ++w.stampN;
  const i0 = Math.floor((p[0] - r) / GRID), i1 = Math.floor((p[0] + r) / GRID);
  const j0 = Math.floor((p[2] - r) / GRID), j1 = Math.floor((p[2] + r) / GRID);
  for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
    const list = w.grid.get(cellKey(i, j));
    if (!list) continue;
    for (const idx of list) if (w.stamp[idx] !== n) { w.stamp[idx] = n; out.push(idx); }
  }
  return out.sort((a, b) => a - b);
}

// Signed distance + gradient for each collider (gradient = outward normal).
function sdf(col: Collider, p: V3): [number, V3] {
  switch (col.k) {
    case 'sph': {
      const d = sub(p, col.c);
      return [len(d) - col.rad, norm(d)];
    }
    case 'cyl': {
      const dx = p[0] - col.c[0], dz = p[2] - col.c[2];
      const rd = hyp2(dx, dz);
      const ex = rd - col.rad;
      const ey = Math.max(col.y0 - p[1], p[1] - col.y1);
      if (ex > 0 && ey > 0) {
        const l = hyp2(ex, ey);
        return [l, norm([(dx / rd) * ex, p[1] > col.y1 ? ey : -ey, (dz / rd) * ex])];
      }
      if (ex > ey) return [ex, rd > 1e-6 ? [dx / rd, 0, dz / rd] : [1, 0, 0]];
      return [ey, [0, p[1] > (col.y0 + col.y1) / 2 ? 1 : -1, 0]];
    }
    case 'obb': {
      // to local (rotate by -yaw)
      const dx = p[0] - col.c[0], dy = p[1] - col.c[1], dz = p[2] - col.c[2];
      const lx = col.cs * dx - col.sn * dz, lz = col.sn * dx + col.cs * dz;
      const qx = Math.abs(lx) - col.h[0], qy = Math.abs(dy) - col.h[1], qz = Math.abs(lz) - col.h[2];
      let n: V3;
      let d: number;
      if (qx > 0 || qy > 0 || qz > 0) {
        const ox = Math.max(qx, 0), oy = Math.max(qy, 0), oz = Math.max(qz, 0);
        d = hyp3(ox, oy, oz);
        n = [Math.sign(lx) * ox, Math.sign(dy) * oy, Math.sign(lz) * oz];
      } else {
        d = Math.max(qx, qy, qz);
        n = qx === d ? [Math.sign(lx), 0, 0] : qy === d ? [0, Math.sign(dy), 0] : [0, 0, Math.sign(lz)];
      }
      n = norm(n);
      // back to world (rotate by +yaw)
      return [d, [col.cs * n[0] + col.sn * n[2], n[1], -col.sn * n[0] + col.cs * n[2]]];
    }
    case 'tor': {
      // Ring stands vertical, its axis along the line's forward direction.
      const dx = p[0] - col.c[0], dy = p[1] - col.c[1], dz = p[2] - col.c[2];
      const lx = col.cs * dx - col.sn * dz, lz = col.sn * dx + col.cs * dz;
      const q = hyp2(lx, dy);
      const ux = q > 1e-6 ? lx / q : 1, uy = q > 1e-6 ? dy / q : 0;
      const rx = lx - ux * col.R, ry = dy - uy * col.R;
      const l = hyp3(rx, ry, lz);
      const n: V3 = l > 1e-6 ? [rx / l, ry / l, lz / l] : [0, 1, 0];
      return [l - col.r, [col.cs * n[0] + col.sn * n[2], n[1], -col.sn * n[0] + col.cs * n[2]]];
    }
  }
}

export interface Contact { n: V3; depth: number }

/**
 * Push a sphere out of terrain, water, objects and bounds. Mutates `p`.
 * Returns the contacts so the caller can kill inward velocity.
 */
export function collideSphere(w: World, p: V3, r: number): Contact[] {
  const out: Contact[] = [];
  const s = w.map.size - 2;
  for (let a = 0; a < 3; a += 2) {
    if (p[a] > s) { out.push({ n: a === 0 ? [-1, 0, 0] : [0, 0, -1], depth: p[a] - s }); p[a] = s; }
    if (p[a] < -s) { out.push({ n: a === 0 ? [1, 0, 0] : [0, 0, 1], depth: -s - p[a] }); p[a] = -s; }
  }
  if (p[1] > CEILING) { out.push({ n: [0, -1, 0], depth: p[1] - CEILING }); p[1] = CEILING; }

  const g = heightAt(w.hf, p[0], p[2]);
  if (p[1] - r < g) {
    const n = normalAt(w.hf, p[0], p[2]);
    const depth = (g - (p[1] - r)) * n[1];
    p[0] += n[0] * depth; p[1] += n[1] * depth; p[2] += n[2] * depth;
    if (p[1] - r < heightAt(w.hf, p[0], p[2])) p[1] = heightAt(w.hf, p[0], p[2]) + r;
    out.push({ n, depth });
  }
  if (w.hf.water !== null && p[1] - r < w.hf.water) {
    out.push({ n: [0, 1, 0], depth: w.hf.water - (p[1] - r) });
    p[1] = w.hf.water + r;
  }
  for (const idx of nearby(w, p, r)) {
    const c = w.colliders[idx];
    const dx = p[0] - c.bc[0], dy = p[1] - c.bc[1], dz = p[2] - c.bc[2];
    const lim = c.br + r;
    if (dx * dx + dy * dy + dz * dz > lim * lim) continue;
    const [d, n] = sdf(c, p);
    if (d < r) {
      const depth = r - d;
      p[0] += n[0] * depth; p[1] += n[1] * depth; p[2] += n[2] * depth;
      out.push({ n, depth });
    }
  }
  return out;
}

/** Distance along a normalized ray to the first solid hit, or Infinity. */
export function raycastWorld(w: World, o: V3, d: V3, maxDist: number): number {
  let best = maxDist;
  // terrain + water: coarse march then bisect
  const step = 1.5;
  let prevT = 0;
  const above = (t: number) => o[1] + d[1] * t - groundAt(w.hf, o[0] + d[0] * t, o[2] + d[2] * t);
  if (above(0) < 0) return 0;
  for (let t = step; t <= best; t += step) {
    if (above(t) < 0) {
      let lo = prevT, hi = t;
      for (let i = 0; i < 8; i++) {
        const m = (lo + hi) / 2;
        if (above(m) < 0) hi = m; else lo = m;
      }
      best = hi;
      break;
    }
    prevT = t;
  }
  // colliders: bounding-sphere reject then sphere-trace the SDF
  for (const c of w.colliders) {
    const oc = sub(c.bc, o);
    const tc = dot(oc, d);
    if (tc < -c.br || tc - c.br > best) continue;
    const perp2 = dot(oc, oc) - tc * tc;
    if (perp2 > c.br * c.br) continue;
    let t = Math.max(0, tc - c.br);
    const tEnd = Math.min(best, tc + c.br);
    for (let i = 0; i < 48 && t <= tEnd; i++) {
      const [dd] = sdf(c, [o[0] + d[0] * t, o[1] + d[1] * t, o[2] + d[2] * t]);
      if (dd < 0.02) { best = Math.min(best, t); break; }
      t += Math.max(dd, 0.02);
    }
  }
  return best < maxDist ? best : Infinity;
}

/** Ray vs sphere; returns entry distance or Infinity. */
export function raySphere(o: V3, d: V3, c: V3, r: number): number {
  const oc = sub(o, c);
  const b = dot(oc, d);
  const cc = dot(oc, oc) - r * r;
  const disc = b * b - cc;
  if (disc < 0) return Infinity;
  const t = -b - Math.sqrt(disc);
  return t >= 0 ? t : cc < 0 ? 0 : Infinity;
}
