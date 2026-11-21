// Map format, validation, and the baked heightfield every system samples.
import { dsin, dcos, hyp2, hyp3 } from './dmath.ts';
import { type V3, clamp } from './math.ts';
import { fbm } from './rng.ts';

export type Sky = 'day' | 'dusk' | 'night' | 'overcast';
export type ObjType = 'box' | 'cyl' | 'tree' | 'ring' | 'rock' | 'pad';
export const OBJ_TYPES: ObjType[] = ['box', 'cyl', 'tree', 'ring', 'rock', 'pad'];

/** A start/finish line or checkpoint: a frame of width w, height h, centered at p, facing yaw r. */
export interface Line { p: V3; r: number; w: number; h: number }
/** p = base (or center for ring/rock), s = size, r = yaw, c = hex color. */
export interface Obj { t: ObjType; p: V3; s: V3; r: number; c: string; tx?: string }

/** Built-in procedural textures (generated client-side, no assets to ship). */
export const BUILTIN_TEXTURES = ['grass', 'dirt', 'sand', 'snow', 'rock', 'concrete', 'brick', 'wood', 'metal', 'checker', 'neon', 'ice', 'lava', 'hazard'] as const;
/** Texture key: `b:<builtin>` or `u:<uploaded id>`. */
export const TEXTURE_KEY = /^(b:[a-z]{2,12}|u:[a-z0-9]{10,24})$/;
export const textureKey = (x: unknown): string | undefined =>
  typeof x === 'string' && TEXTURE_KEY.test(x) && (!x.startsWith('b:') || (BUILTIN_TEXTURES as readonly string[]).includes(x.slice(2))) ? x : undefined;
/** [x, z, radius, amount, mode]; mode 0 = raise/lower by amount, 1 = flatten to height amount, 2 = smooth */
export type Brush = [number, number, number, number, number];

export interface Terrain { seed: number; amp: number; scale: number; octaves: number; base: number; brushes: Brush[] }

export interface MapData {
  v: 1;
  name: string;
  author: string;
  desc: string;
  size: number; // half-extent of the playable square, meters
  terrain: Terrain;
  water: number | null;
  sky: Sky;
  /** Ground texture key; undefined = height/slope-blended default. */
  ground?: string;
  start: Line;
  checkpoints: Line[];
  objects: Obj[];
  spawns: { p: V3; r: number }[];
  laps: number;
}

export const LIMITS = { objects: 1500, checkpoints: 64, brushes: 800, spawns: 16, name: 40, desc: 240, size: [100, 600] as const };
export const CELL = 2; // heightfield resolution, meters
export const CEILING = 220;

export function emptyMap(): MapData {
  return {
    v: 1,
    name: 'Untitled Track',
    author: '',
    desc: '',
    size: 250,
    terrain: { seed: 1234, amp: 18, scale: 140, octaves: 5, base: 0, brushes: [] },
    water: null,
    sky: 'day',
    start: { p: [0, 4, 0], r: 0, w: 10, h: 6 },
    checkpoints: [],
    objects: [],
    spawns: [],
    laps: 3,
  };
}

const num = (x: unknown, lo: number, hi: number, d: number) =>
  typeof x === 'number' && Number.isFinite(x) ? clamp(x, lo, hi) : d;
const vec = (x: unknown, lim: number, d: V3 = [0, 0, 0]): V3 =>
  Array.isArray(x) && x.length === 3 ? [num(x[0], -lim, lim, d[0]), num(x[1], -200, 400, d[1]), num(x[2], -lim, lim, d[2])] : d;
const str = (x: unknown, max: number, d = '') =>
  typeof x === 'string' ? x.replace(/[\u0000-\u001f<>]/g, '').trim().slice(0, max) : d;
const color = (x: unknown, d: string) => (typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x.toLowerCase() : d);
const DEFAULT_COLORS: Record<ObjType, string> = {
  box: '#8a8f98', cyl: '#a0a4ab', tree: '#3d7a3a', ring: '#ff7a1a', rock: '#7d7468', pad: '#2b2f36',
};

function line(x: any, lim: number, d: Line): Line {
  if (!x || typeof x !== 'object') return d;
  return { p: vec(x.p, lim, d.p), r: num(x.r, -10, 10, 0), w: num(x.w, 3, 40, d.w), h: num(x.h, 2, 30, d.h) };
}

/** Coerce untrusted JSON into a well-formed map (clamping instead of rejecting where possible). */
export function sanitizeMap(raw: any): MapData {
  const m = emptyMap();
  if (!raw || typeof raw !== 'object') return m;
  m.name = str(raw.name, LIMITS.name, m.name) || m.name;
  m.author = str(raw.author, 24);
  m.desc = str(raw.desc, LIMITS.desc);
  m.size = num(raw.size, LIMITS.size[0], LIMITS.size[1], m.size);
  const lim = m.size;
  const t = raw.terrain ?? {};
  m.terrain = {
    seed: Math.floor(num(t.seed, 0, 2 ** 31 - 1, m.terrain.seed)),
    amp: num(t.amp, 0, 120, m.terrain.amp),
    scale: num(t.scale, 20, 600, m.terrain.scale),
    octaves: Math.floor(num(t.octaves, 1, 7, m.terrain.octaves)),
    base: num(t.base, -50, 100, 0),
    brushes: (Array.isArray(t.brushes) ? t.brushes : [])
      .slice(0, LIMITS.brushes)
      .filter((b: any) => Array.isArray(b) && b.length === 5)
      .map((b: any): Brush => [num(b[0], -lim, lim, 0), num(b[1], -lim, lim, 0), num(b[2], 2, 120, 10), num(b[3], -150, 250, 0), b[4] === 1 ? 1 : b[4] === 2 ? 2 : 0]),
  };
  m.water = raw.water === null || raw.water === undefined ? null : num(raw.water, -50, 150, 0);
  m.sky = (['day', 'dusk', 'night', 'overcast'] as Sky[]).includes(raw.sky) ? raw.sky : 'day';
  m.start = line(raw.start, lim, m.start);
  m.checkpoints = (Array.isArray(raw.checkpoints) ? raw.checkpoints : []).slice(0, LIMITS.checkpoints).map((c: any) => line(c, lim, { p: [0, 4, 0], r: 0, w: 8, h: 6 }));
  m.objects = (Array.isArray(raw.objects) ? raw.objects : [])
    .slice(0, LIMITS.objects)
    .filter((o: any) => o && OBJ_TYPES.includes(o.t))
    .map((o: any): Obj => ({
      t: o.t,
      p: vec(o.p, lim),
      s: Array.isArray(o.s) && o.s.length === 3 ? [num(o.s[0], 0.2, 200, 4), num(o.s[1], 0.2, 200, 4), num(o.s[2], 0.2, 200, 4)] : [4, 4, 4],
      r: num(o.r, -10, 10, 0),
      c: color(o.c, DEFAULT_COLORS[o.t as ObjType]),
      ...(textureKey(o.tx) ? { tx: textureKey(o.tx) } : {}),
    }));
  if (textureKey(raw.ground)) m.ground = textureKey(raw.ground);
  m.spawns = (Array.isArray(raw.spawns) ? raw.spawns : []).slice(0, LIMITS.spawns).map((s: any) => ({ p: vec(s?.p, lim), r: num(s?.r, -10, 10, 0) }));
  m.laps = Math.floor(num(raw.laps, 1, 10, 3));
  return m;
}

export const defaultColor = (t: ObjType) => DEFAULT_COLORS[t];

// ---------------------------------------------------------------- heightfield

export interface Heightfield {
  size: number;
  n: number; // samples per side
  h: Float32Array;
  water: number | null;
}

const smoothstep = (e0: number, e1: number, x: number) => {
  const t = clamp((x - e0) / (e1 - e0), 0, 1);
  return t * t * (3 - 2 * t);
};

/** Raw procedural height before brushes. Ridged blend gives sharper mountain crests. */
function baseHeight(t: Terrain, size: number, x: number, z: number) {
  const n = fbm(x / t.scale, z / t.scale, t.seed, t.octaves);
  const ridge = 1 - Math.abs(fbm(x / (t.scale * 1.7) + 31.7, z / (t.scale * 1.7) - 12.3, t.seed + 77, 4));
  let h = t.base + t.amp * (n * 0.75 + (ridge * ridge - 0.45) * 0.6);
  // Rim mountains so the map edge reads as a natural boundary.
  const edge = Math.max(Math.abs(x), Math.abs(z)) / size;
  h += smoothstep(0.86, 1.0, edge) * 45;
  return h;
}

export function bakeHeightfield(m: MapData): Heightfield {
  const n = Math.floor((m.size * 2) / CELL) + 1;
  const h = new Float32Array(n * n);
  const t = m.terrain;
  for (let j = 0; j < n; j++) {
    const z = -m.size + j * CELL;
    for (let i = 0; i < n; i++) h[j * n + i] = baseHeight(t, m.size, -m.size + i * CELL, z);
  }
  // Brushes touch only the cells inside their radius, so hundreds of them stay cheap.
  for (const [bx, bz, br, amt, mode] of t.brushes) {
    const i0 = Math.max(0, Math.floor((bx - br + m.size) / CELL)), i1 = Math.min(n - 1, Math.ceil((bx + br + m.size) / CELL));
    const j0 = Math.max(0, Math.floor((bz - br + m.size) / CELL)), j1 = Math.min(n - 1, Math.ceil((bz + br + m.size) / CELL));
    let src: Float32Array | null = null;
    if (mode === 2) src = h.slice();
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const dx = -m.size + i * CELL - bx, dz = -m.size + j * CELL - bz;
      const d = hyp2(dx, dz) / br;
      if (d >= 1) continue;
      const f = 1 - smoothstep(0, 1, d);
      const k = j * n + i;
      if (mode === 0) h[k] += amt * f;
      else if (mode === 1) h[k] += (amt - h[k]) * Math.min(1, f * 1.6);
      else if (src) {
        let s = 0, c = 0;
        for (let dj = -2; dj <= 2; dj++) for (let di = -2; di <= 2; di++) {
          const ii = i + di, jj = j + dj;
          if (ii >= 0 && jj >= 0 && ii < n && jj < n) { s += src[jj * n + ii]; c++; }
        }
        h[k] += (s / c - h[k]) * f * clamp(amt / 10, 0.1, 1);
      }
    }
  }
  return { size: m.size, n, h, water: m.water };
}

export function heightAt(hf: Heightfield, x: number, z: number) {
  const fx = clamp((x + hf.size) / CELL, 0, hf.n - 1.001);
  const fz = clamp((z + hf.size) / CELL, 0, hf.n - 1.001);
  const i = Math.floor(fx), j = Math.floor(fz);
  const u = fx - i, v = fz - j;
  const n = hf.n, h = hf.h;
  const a = h[j * n + i], b = h[j * n + i + 1], c = h[(j + 1) * n + i], d = h[(j + 1) * n + i + 1];
  return (a + (b - a) * u) * (1 - v) + (c + (d - c) * u) * v;
}

/** Ground including the water surface (water counts as solid for flying). */
export const groundAt = (hf: Heightfield, x: number, z: number) => {
  const g = heightAt(hf, x, z);
  return hf.water !== null && hf.water > g ? hf.water : g;
};

export function normalAt(hf: Heightfield, x: number, z: number): V3 {
  const e = CELL * 0.5;
  const dx = heightAt(hf, x + e, z) - heightAt(hf, x - e, z);
  const dz = heightAt(hf, x, z + e) - heightAt(hf, x, z - e);
  const l = hyp3(dx, 2 * e, dz);
  return [-dx / l, (2 * e) / l, -dz / l];
}

/** Lap order: checkpoints in sequence, then the start/finish line closes the lap. */
export const courseLines = (m: MapData): Line[] => [...m.checkpoints, m.start];

/** Race grid behind the start line, 4 wide. */
export function gridSlot(m: MapData, idx: number): { p: V3; r: number } {
  const s = m.start;
  const fwd: V3 = [-dsin(s.r), 0, -dcos(s.r)];
  const right: V3 = [dcos(s.r), 0, -dsin(s.r)];
  const row = Math.floor(idx / 4), col = (idx % 4) - 1.5;
  const back = 8 + row * 5;
  const x = s.p[0] - fwd[0] * back + right[0] * col * 3;
  const z = s.p[2] - fwd[2] * back + right[2] * col * 3;
  return { p: [x, s.p[1], z], r: s.r };
}
