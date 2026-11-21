// Procedural maps: official tracks, random PvP arenas, and an autopilot that
// flies a course (sets official author times + proves a map is finishable).
import { dsin, dcos, datan2, hyp2, hyp3 } from './dmath.ts';
import { mulberry32 } from './rng.ts';
import { type V3, clamp, wrapAngle } from './math.ts';
import { type MapData, type Obj, type Line, type Brush, type Sky, emptyMap, bakeHeightfield, heightAt, sanitizeMap } from './map.ts';
import { type World } from './collide.ts';
import { lineForward } from './course.ts';
import { type QInput, type SimEvent, RunSim, BTN_BOOST, quantYaw, quantPitch } from './replay.ts';

interface TrackSpec {
  slug: string;
  name: string;
  desc: string;
  seed: number;
  sky: Sky;
  amp: number;
  scale: number;
  water: number | null;
  ground?: string;
  points: number; // checkpoints incl. start
  radius: number;
  wobble: number;
  alt: [number, number]; // altitude band above carved floor
  laps: number;
  size: number;
  trees: number;
  rings: boolean;
  towers: number;
}

const yawToward = (dx: number, dz: number) => datan2(-dx, -dz);

export function generateTrack(t: TrackSpec): MapData {
  const rnd = mulberry32(t.seed);
  const m = emptyMap();
  Object.assign(m, { name: t.name, author: 'Hackatoa', desc: t.desc, size: t.size, sky: t.sky, water: t.water, laps: t.laps });
  if (t.ground) m.ground = t.ground;
  m.terrain = { seed: t.seed, amp: t.amp, scale: t.scale, octaves: 5, base: 0, brushes: [] };

  // Closed wobbly loop
  const pts: V3[] = [];
  const phase = rnd() * Math.PI * 2;
  for (let i = 0; i < t.points; i++) {
    const a = (i / t.points) * Math.PI * 2;
    const r = t.radius * (1 + t.wobble * (rnd() * 2 - 1)) * (1 + 0.25 * dsin(a * 2 + phase));
    pts.push([dcos(a) * r, 0, dsin(a) * r * 0.85]);
  }
  // Carve a flying corridor along the loop so checkpoints have line of sight.
  const hf0 = bakeHeightfield(m);
  const floors = pts.map((p) => heightAt(hf0, p[0], p[2]));
  const brushes: Brush[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i], b = pts[(i + 1) % pts.length];
    const len = hyp2(b[0] - a[0], b[2] - a[2]);
    const n = Math.ceil(len / 14);
    for (let k = 0; k < n; k++) {
      const f = k / n;
      const x = a[0] + (b[0] - a[0]) * f, z = a[2] + (b[2] - a[2]) * f;
      const floor = Math.min(heightAt(hf0, x, z), floors[i] + (floors[(i + 1) % pts.length] - floors[i]) * f, t.amp * 0.15);
      brushes.push([Math.round(x * 10) / 10, Math.round(z * 10) / 10, 22, Math.round(floor * 10) / 10, 1]);
    }
  }
  m.terrain.brushes = brushes;
  const hf = bakeHeightfield(m);
  const lines: Line[] = pts.map((p, i) => {
    const prev = pts[(i - 1 + pts.length) % pts.length], next = pts[(i + 1) % pts.length];
    const g = Math.max(heightAt(hf, p[0], p[2]), m.water ?? -1e9);
    const alt = t.alt[0] + rnd() * (t.alt[1] - t.alt[0]);
    return {
      p: [Math.round(p[0] * 10) / 10, Math.round((g + alt) * 10) / 10, Math.round(p[2] * 10) / 10],
      r: Math.round(yawToward(next[0] - prev[0], next[2] - prev[2]) * 1000) / 1000,
      w: i === 0 ? 14 : 9 + Math.round(rnd() * 3),
      h: i === 0 ? 8 : 6 + Math.round(rnd() * 2),
    };
  });
  m.start = lines[0];
  m.checkpoints = lines.slice(1);
  // Flatten the launch grid under the start.
  const sf = lineForward(m.start);
  const gy = m.start.p[1] - m.start.h / 2 - 1.5;
  m.terrain.brushes.push([m.start.p[0] - sf[0] * 14, m.start.p[2] - sf[2] * 14, 20, Math.round(gy * 10) / 10, 1]);
  const objs: Obj[] = [];
  const hf2 = bakeHeightfield(m);
  const nearPath = (x: number, z: number, clear: number) => {
    for (let i = 0; i < pts.length; i++) {
      const a = pts[i], b = pts[(i + 1) % pts.length];
      const abx = b[0] - a[0], abz = b[2] - a[2];
      const f = clamp(((x - a[0]) * abx + (z - a[2]) * abz) / (abx * abx + abz * abz), 0, 1);
      if (hyp2(x - a[0] - abx * f, z - a[2] - abz * f) < clear) return true;
    }
    return false;
  };
  for (let i = 0; i < t.trees; i++) {
    const x = (rnd() * 2 - 1) * t.size * 0.85, z = (rnd() * 2 - 1) * t.size * 0.85;
    if (nearPath(x, z, 20)) continue;
    const g = heightAt(hf2, x, z);
    if (m.water !== null && g < m.water + 0.5) continue;
    const big = rnd();
    if (big < 0.8) objs.push({ t: 'tree', p: [r1(x), r1(g - 0.3), r1(z)], s: [r1(4 + rnd() * 4), r1(9 + rnd() * 10), 0], r: 0, c: t.sky === 'night' ? '#2c5d4a' : '#3d7a3a' });
    else objs.push({ t: 'rock', p: [r1(x), r1(g - 1), r1(z)], s: [r1(3 + rnd() * 6), 0, 0], r: 0, c: '#7d7468' });
  }
  for (let i = 0; i < t.towers; i++) {
    const x = (rnd() * 2 - 1) * t.size * 0.7, z = (rnd() * 2 - 1) * t.size * 0.7;
    if (nearPath(x, z, 18)) continue;
    const g = heightAt(hf2, x, z);
    const h = 15 + rnd() * 40;
    objs.push({ t: 'box', p: [r1(x), r1(g - 1), r1(z)], s: [r1(8 + rnd() * 10), r1(h), r1(8 + rnd() * 10)], r: r1(rnd() * 3), c: '#5b6270', tx: 'b:concrete' });
  }
  if (t.rings) {
    // decorative rings halfway between checkpoints, aligned with the path (they're solid!)
    for (let i = 0; i < lines.length; i += 2) {
      const a = lines[i].p, b = lines[(i + 1) % lines.length].p;
      const c: V3 = [r1((a[0] + b[0]) / 2), r1((a[1] + b[1]) / 2), r1((a[2] + b[2]) / 2)];
      objs.push({ t: 'ring', p: c, s: [16, 0, 2], r: Math.round(yawToward(b[0] - a[0], b[2] - a[2]) * 1000) / 1000, c: t.sky === 'night' ? '#ff2bd6' : '#ff7a1a' });
    }
  }
  m.objects = objs;
  return sanitizeMap(m);
}

const r1 = (x: number) => Math.round(x * 10) / 10;

export const OFFICIAL: TrackSpec[] = [
  { slug: 'meadow-loop', name: 'Meadow Loop', desc: 'Gentle hills and wide checkpoints. Start here.', seed: 1101, sky: 'day', amp: 14, scale: 150, water: null, points: 8, radius: 120, wobble: 0.2, alt: [4, 9], laps: 3, size: 220, trees: 260, rings: false, towers: 0 },
  { slug: 'canyon-run', name: 'Canyon Run', desc: 'A corridor carved through red rock. Stay low.', seed: 2207, sky: 'dusk', amp: 60, scale: 110, water: null, ground: 'b:sand', points: 11, radius: 170, wobble: 0.35, alt: [5, 10], laps: 2, size: 280, trees: 60, rings: true, towers: 0 },
  { slug: 'lakeside', name: 'Lakeside Sprint', desc: 'Skim the water between the islands.', seed: 3313, sky: 'overcast', amp: 26, scale: 90, water: 1, points: 10, radius: 150, wobble: 0.3, alt: [3, 8], laps: 3, size: 240, trees: 180, rings: false, towers: 0 },
  { slug: 'neon-city', name: 'Neon City', desc: 'Night run between towers and glowing rings.', seed: 4419, sky: 'night', amp: 6, scale: 200, water: null, ground: 'b:concrete', points: 12, radius: 160, wobble: 0.25, alt: [6, 16], laps: 3, size: 240, trees: 0, rings: true, towers: 70 },
  { slug: 'alpine', name: 'Alpine Dash', desc: 'Big elevation changes through snowy peaks.', seed: 5527, sky: 'day', amp: 80, scale: 160, water: null, ground: 'b:snow', points: 10, radius: 200, wobble: 0.3, alt: [6, 12], laps: 2, size: 320, trees: 220, rings: false, towers: 0 },
];

export const officialMap = (slug: string) => {
  const t = OFFICIAL.find((x) => x.slug === slug);
  return t ? generateTrack(t) : null;
};

// ---------------------------------------------------------------- PvP arenas

export function generateArena(seed: number): MapData {
  const rnd = mulberry32(seed);
  const m = emptyMap();
  const skies: Sky[] = ['day', 'dusk', 'night', 'overcast'];
  const grounds = ['b:grass', 'b:sand', 'b:snow', 'b:dirt', 'b:concrete'];
  m.name = `Arena #${seed % 10000}`;
  m.author = 'Arena generator';
  m.size = 170;
  m.sky = skies[Math.floor(rnd() * skies.length)];
  m.ground = grounds[Math.floor(rnd() * grounds.length)];
  m.terrain = { seed, amp: 10 + rnd() * 30, scale: 70 + rnd() * 80, octaves: 5, base: 0, brushes: [] };
  m.water = rnd() < 0.3 ? -2 : null;
  const hf = bakeHeightfield(m);
  const objs: Obj[] = [];
  const style = Math.floor(rnd() * 3); // 0 city, 1 forest, 2 ruins
  const n = 70 + Math.floor(rnd() * 50);
  for (let i = 0; i < n; i++) {
    const x = (rnd() * 2 - 1) * 140, z = (rnd() * 2 - 1) * 140;
    const g = heightAt(hf, x, z);
    if (m.water !== null && g < m.water) continue;
    const k = rnd();
    if (style === 0 || (style === 2 && k < 0.5)) {
      const h = style === 0 ? 10 + rnd() * 45 : 4 + rnd() * 14;
      objs.push({ t: 'box', p: [r1(x), r1(g - 1), r1(z)], s: [r1(6 + rnd() * 12), r1(h), r1(6 + rnd() * 12)], r: r1(rnd() * 3), c: '#6b7280', tx: style === 0 ? 'b:concrete' : 'b:brick' });
    } else if (style === 1 || k < 0.75) {
      objs.push({ t: 'tree', p: [r1(x), r1(g - 0.3), r1(z)], s: [r1(5 + rnd() * 4), r1(12 + rnd() * 12), 0], r: 0, c: '#3d7a3a' });
    } else {
      objs.push({ t: 'cyl', p: [r1(x), r1(g - 1), r1(z)], s: [r1(2 + rnd() * 4), r1(8 + rnd() * 20), 0], r: 0, c: '#8a8f98', tx: 'b:metal' });
    }
  }
  m.objects = objs;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = dcos(a) * 125, z = dsin(a) * 125;
    m.spawns.push({ p: [r1(x), r1(heightAt(hf, x, z) + 12), r1(z)], r: Math.round(yawToward(-x, -z) * 1000) / 1000 });
  }
  // Required by the schema; tucked at the edge, unused in PvP.
  m.start = { p: [0, heightAt(hf, 0, -150) + 6, -150], r: 0, w: 8, h: 5 };
  return sanitizeMap(m);
}

// ---------------------------------------------------------------- autopilot

/**
 * Flies the course in arcade mode, aiming through each line's center with a
 * little lead toward the next. Returns the recorded inputs; feed them to
 * replayRun for the official result.
 */
/** Per-tick autopilot controller (arcade). Used by autopilot() and by dev e2e tests. */
export function makePilot(world: World, sim0: RunSim) {
  let yaw = sim0.drone.yaw, pitch = 0;
  return (sim: RunSim): QInput => {
    const p = sim.progress!;
    const lines = p.lines;
    const target = p.started ? lines[p.next] : world.map.start;
    const d = sim.drone.p;
    const f = lineForward(target);
    // Pure pursuit along the line's axis: aim 12 m ahead of our projection
    // onto it, so we converge on the center and cross square to the frame.
    const along = (d[0] - target.p[0]) * f[0] + (d[2] - target.p[2]) * f[2];
    let k = clamp(along + 12, -15, 8);
    if (along > 0.5) k = -25; // overshot without crossing: loop back behind it
    const aim: V3 = [target.p[0] + f[0] * k, target.p[1], target.p[2] + f[2] * k];
    const dx = aim[0] - d[0], dy = aim[1] - d[1], dz = aim[2] - d[2];
    const wantYaw = yawToward(dx, dz);
    const wantPitch = datan2(dy, hyp2(dx, dz));
    const dyaw = wrapAngle(wantYaw - yaw);
    yaw = wrapAngle(yaw + clamp(dyaw, -0.06, 0.06));
    pitch += clamp(wantPitch - pitch, -0.04, 0.04);
    const err = Math.abs(dyaw);
    const distToLine = hyp3(dx, dy, dz);
    const q: QInput = {
      b: err < 0.25 && distToLine > 30 ? BTN_BOOST : 0,
      mx: 0,
      mz: err > 1.2 ? 40 : 127,
      my: clamp(Math.round(dy * 2), -30, 30),
      yaw: quantYaw(yaw),
      pitch: quantPitch(clamp(pitch, -1.2, 1.2)),
      rp: 0, rr: 0, ry: 0,
    };
    return q;
  };
}

export function autopilot(world: World, laps: number, maxTicks = 120 * 60 * 8, onEvent?: (e: SimEvent, sim: RunSim) => void): QInput[] | null {
  const sim = new RunSim(world, { mode: 'arcade', rates: 1, laps });
  const pilot = makePilot(world, sim);
  const inputs: QInput[] = [];
  while (sim.tick < maxTicks) {
    const q = pilot(sim);
    inputs.push(q);
    const evs = sim.step(q);
    if (onEvent) for (const e of evs) onEvent(e, sim);
    if (sim.finished) return inputs;
  }
  return null;
}
