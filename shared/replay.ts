// Deterministic run simulation + compact input recording.
//
// A run file is just the quantized input for every 120 Hz physics tick. The
// live game feeds the same quantized inputs through the same RunSim, so a
// replay — in any browser or on the server — lands on the exact same time.
import type { V3 } from './math.ts';
import { type MapData, gridSlot } from './map.ts';
import { type World } from './collide.ts';
import { type DroneState, type FlightMode, type Input, DT, CRASH_SPEED, newDrone, step, emptyInput } from './physics.ts';
import { Progress, type ProgressEvent } from './course.ts';

export const TICK_HZ = 120;
export const TICK_MS = 1000 / TICK_HZ;
export const MAX_TICKS = TICK_HZ * 60 * 20; // 20 minutes
export const CRASH_TICKS = 90; // frozen after a crash before respawning
const ANG = 1e-4; // radians per quantized look unit
const ANG_WRAP = 31416; // round(pi / ANG)

export const BTN_BOOST = 1;
export const BTN_RESPAWN = 2;
export const BTN_LEVEL = 4;

/** Integer-only input: what's recorded, and the only thing the sim ever sees. */
export interface QInput { b: number; mx: number; mz: number; my: number; yaw: number; pitch: number; rp: number; rr: number; ry: number }
export const emptyQ = (): QInput => ({ b: 0, mx: 0, mz: 0, my: 0, yaw: 0, pitch: 0, rp: 0, rr: 0, ry: 0 });

const q8 = (x: number) => Math.max(-127, Math.min(127, Math.round(x * 127)));
export const quantYaw = (rad: number) => {
  let v = Math.round(rad / ANG);
  // half-open [-WRAP, WRAP) so every angle has exactly one encoding
  while (v >= ANG_WRAP) v -= ANG_WRAP * 2;
  while (v < -ANG_WRAP) v += ANG_WRAP * 2;
  return v;
};
export const quantPitch = (rad: number) => Math.max(-14500, Math.min(14500, Math.round(rad / ANG)));

export function quantize(i: Input, buttons: number): QInput {
  return { b: buttons & 0xff, mx: q8(i.mx), mz: q8(i.mz), my: q8(i.my), yaw: quantYaw(i.yaw), pitch: quantPitch(i.pitch), rp: q8(i.rp), rr: q8(i.rr), ry: q8(i.ry) };
}
export function dequantize(q: QInput, out: Input = emptyInput()): Input {
  out.mx = q.mx / 127; out.mz = q.mz / 127; out.my = q.my / 127;
  out.boost = (q.b & BTN_BOOST) !== 0;
  out.level = (q.b & BTN_LEVEL) !== 0;
  out.yaw = q.yaw * ANG; out.pitch = q.pitch * ANG;
  out.rp = q.rp / 127; out.rr = q.rr / 127; out.ry = q.ry / 127;
  return out;
}

// ------------------------------------------------------------------ encoding
// Per tick: header byte. 0x80|n = repeat previous input n+1 times (n<=127).
// Otherwise header is a change mask followed by the changed fields:
//   1 b(u8) 2 mx(i8) 4 mz(i8) 8 my(i8) 16 yaw(Δ i16) 32 pitch(Δ i16) 64 rp,rr,ry(i8×3)

export function encodeInputs(ticks: QInput[]): Uint8Array {
  const out: number[] = [];
  let prev = emptyQ();
  let i = 0;
  const i8 = (v: number) => out.push(v & 0xff);
  const i16 = (v: number) => { out.push(v & 0xff, (v >> 8) & 0xff); };
  while (i < ticks.length) {
    const q = ticks[i];
    let mask = 0;
    if (q.b !== prev.b) mask |= 1;
    if (q.mx !== prev.mx) mask |= 2;
    if (q.mz !== prev.mz) mask |= 4;
    if (q.my !== prev.my) mask |= 8;
    if (q.yaw !== prev.yaw) mask |= 16;
    if (q.pitch !== prev.pitch) mask |= 32;
    if (q.rp !== prev.rp || q.rr !== prev.rr || q.ry !== prev.ry) mask |= 64;
    if (mask === 0) {
      let n = 1;
      while (n < 128 && i + n < ticks.length && sameQ(ticks[i + n], prev)) n++;
      out.push(0x80 | (n - 1));
      i += n;
      continue;
    }
    out.push(mask);
    if (mask & 1) out.push(q.b);
    if (mask & 2) i8(q.mx);
    if (mask & 4) i8(q.mz);
    if (mask & 8) i8(q.my);
    if (mask & 16) {
      let d = q.yaw - prev.yaw;
      if (d >= ANG_WRAP) d -= ANG_WRAP * 2;
      if (d < -ANG_WRAP) d += ANG_WRAP * 2;
      i16(d);
    }
    if (mask & 32) i16(q.pitch - prev.pitch);
    if (mask & 64) { i8(q.rp); i8(q.rr); i8(q.ry); }
    prev = q;
    i++;
  }
  return Uint8Array.from(out);
}

const sameQ = (a: QInput, b: QInput) =>
  a.b === b.b && a.mx === b.mx && a.mz === b.mz && a.my === b.my && a.yaw === b.yaw && a.pitch === b.pitch && a.rp === b.rp && a.rr === b.rr && a.ry === b.ry;

export function decodeInputs(bytes: Uint8Array, maxTicks = MAX_TICKS): QInput[] {
  const out: QInput[] = [];
  let prev = emptyQ();
  let p = 0;
  const s8 = () => { if (p >= bytes.length) throw new Error('truncated'); const v = bytes[p++]; return v > 127 ? v - 256 : v; };
  const s16 = () => { if (p + 1 >= bytes.length) throw new Error('truncated'); const v = bytes[p] | (bytes[p + 1] << 8); p += 2; return v > 32767 ? v - 65536 : v; };
  while (p < bytes.length) {
    const h = bytes[p++];
    if (h & 0x80) {
      const n = (h & 0x7f) + 1;
      for (let k = 0; k < n; k++) out.push(prev);
    } else {
      const q = { ...prev };
      if (h & 1) { if (p >= bytes.length) throw new Error('truncated'); q.b = bytes[p++]; }
      if (h & 2) q.mx = s8();
      if (h & 4) q.mz = s8();
      if (h & 8) q.my = s8();
      if (h & 16) { q.yaw += s16(); if (q.yaw >= ANG_WRAP) q.yaw -= ANG_WRAP * 2; if (q.yaw < -ANG_WRAP) q.yaw += ANG_WRAP * 2; }
      if (h & 32) q.pitch = Math.max(-14500, Math.min(14500, q.pitch + s16()));
      if (h & 64) { q.rp = s8(); q.rr = s8(); q.ry = s8(); }
      for (const k of ['mx', 'mz', 'my', 'rp', 'rr', 'ry'] as const) if (q[k] < -127) q[k] = -127;
      out.push(q);
      prev = q;
    }
    if (out.length > maxTicks) throw new Error('too long');
  }
  return out;
}

// ------------------------------------------------------------------ attestation
// Rolling FNV-1a over every tick's quantized input. The client streams
// (tick, hash) heartbeats live; the server timestamps them, then recomputes
// the hashes while replaying — proving the inputs existed at that wall time.
export const HB_EVERY_TICKS = 60; // heartbeat every 0.5 s of sim time
export function hashStep(h: number, q: QInput): number {
  const vals = [q.b, q.mx, q.mz, q.my, q.yaw, q.pitch, q.rp, q.rr, q.ry];
  for (const v of vals) {
    h ^= v & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >> 8) & 0xff; h = Math.imul(h, 0x01000193);
    h ^= (v >> 16) & 0xff; h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}
export const HASH_SEED = 0x811c9dc5;

/**
 * Real-time check: sim time between consecutive heartbeats must track the
 * server's wall clock. Slowing the game (or fast-forwarding later to make up
 * for it) breaks this on the affected intervals.
 */
export function checkHeartbeats(hb: { tick: number; h: number; at: number }[], inputs: QInput[], finishTick: number): string | null {
  if (hb.length < 2) return 'run was not attested live';
  if (hb[0].tick > 5 * HB_EVERY_TICKS) return 'attestation started late';
  if (finishTick - hb[hb.length - 1].tick > 4 * HB_EVERY_TICKS) return 'attestation ended early';
  let h = HASH_SEED;
  let k = 0;
  for (let t = 0; t < inputs.length && k < hb.length; t++) {
    h = hashStep(h, inputs[t]);
    while (k < hb.length && hb[k].tick === t + 1) {
      if (hb[k].h !== h) return 'inputs differ from what was flown live';
      k++;
    }
  }
  if (k < hb.length) return 'heartbeat beyond run end';
  for (let i = 1; i < hb.length; i++) {
    const simMs = (hb[i].tick - hb[i - 1].tick) * TICK_MS;
    const wallMs = hb[i].at - hb[i - 1].at;
    if (simMs <= 0) return 'heartbeats out of order';
    // generous on short jittery gaps, strict over longer spans
    if (wallMs > simMs * 1.12 + 700) return `game ran slow around ${(hb[i].tick / TICK_HZ).toFixed(1)}s`;
    if (wallMs < simMs * 0.88 - 700) return `game ran fast around ${(hb[i].tick / TICK_HZ).toFixed(1)}s`;
  }
  // sliding ~10 s windows: tight enough to catch partial slow-downs that are
  // made up for later, loose enough for a TCP stall delaying one heartbeat
  const W = 20;
  for (let i = W; i < hb.length; i++) {
    const simMs = (hb[i].tick - hb[i - W].tick) * TICK_MS;
    const wallMs = hb[i].at - hb[i - W].at;
    if (Math.abs(wallMs - simMs) > simMs * 0.05 + 700) return `game ran ${wallMs > simMs ? 'slow' : 'fast'} around ${(hb[i].tick / TICK_HZ).toFixed(0)}s (low FPS or connection stall?)`;
  }
  // and over the whole run, network jitter averages out
  const simAll = (hb[hb.length - 1].tick - hb[0].tick) * TICK_MS;
  const wallAll = hb[hb.length - 1].at - hb[0].at;
  if (simAll > 5000 && Math.abs(wallAll - simAll) > simAll * 0.04 + 1500) return 'run speed does not match real time';
  return null;
}

/** Stable id of an input stream (dedupe). */
export function inputsDigest(inputs: QInput[]): string {
  let a = HASH_SEED, b = 0x12345678;
  for (const q of inputs) { a = hashStep(a, q); b = hashStep(b ^ a, q); }
  return `${inputs.length.toString(36)}-${a.toString(16)}-${b.toString(16)}`;
}

// ------------------------------------------------------------------ sim

export type SimEvent = ProgressEvent | { e: 'crash'; impact: number } | { e: 'respawn' } | { e: 'bump'; impact: number };

export interface RunHeader { mode: FlightMode; rates: number; laps: number }

/** One pilot's deterministic simulation. Used for time trials, free roam, races, PvP and replays. */
export class RunSim {
  drone: DroneState;
  progress: Progress | null;
  tick = 0;
  crashTimer = 0;
  private input = emptyInput();
  private spawn: { p: V3; r: number };

  constructor(public world: World, public header: RunHeader, opts: { course?: boolean; spawn?: { p: V3; r: number } } = {}) {
    this.spawn = opts.spawn ?? spawnFor(world.map);
    this.drone = newDrone(this.spawn.p, this.spawn.r);
    this.progress = opts.course === false ? null : new Progress(world.map, header.laps);
  }

  get timeMs() { return this.tick * TICK_MS; }
  get finished() { return this.progress?.finished ?? false; }

  respawn() {
    const rp = this.progress ? this.progress.respawnPoint(this.spawn) : this.spawn;
    this.drone = newDrone(rp.p, rp.r);
    this.crashTimer = 0;
  }

  /** Advance exactly one tick. `extra` lets the caller apply non-recorded effects (other drones) — never used for time trials. */
  step(q: QInput, extra?: (d: DroneState) => void): SimEvent[] {
    const ev: SimEvent[] = [];
    const tA = this.timeMs;
    this.tick++;
    if (this.finished) return ev;
    if (this.crashTimer > 0) {
      if (--this.crashTimer === 0) { this.respawn(); ev.push({ e: 'respawn' }); }
      return ev;
    }
    if (q.b & BTN_RESPAWN) { this.respawn(); ev.push({ e: 'respawn' }); return ev; }
    dequantize(q, this.input);
    const a: V3 = [this.drone.p[0], this.drone.p[1], this.drone.p[2]];
    const r = step(this.drone, this.input, this.header.mode, this.world, this.header.rates);
    extra?.(this.drone);
    if (this.progress) ev.push(...this.progress.feed(a, this.drone.p, tA, this.timeMs));
    if (r.impact > CRASH_SPEED) {
      this.crashTimer = CRASH_TICKS;
      this.drone.v = [0, 0, 0];
      ev.push({ e: 'crash', impact: r.impact });
    } else if (r.impact > 3) ev.push({ e: 'bump', impact: r.impact });
    return ev;
  }
}

export const spawnFor = (m: MapData) => gridSlot(m, 0);

export interface ReplayResult { ok: boolean; reason?: string; totalMs?: number; lapTimes?: number[]; ticks?: number }

/** Re-simulate a full run from inputs. This is what the server trusts. */
export function replayRun(world: World, header: RunHeader, inputs: QInput[]): ReplayResult {
  if (header.mode !== 'arcade' && header.mode !== 'acro') return { ok: false, reason: 'bad mode' };
  const sim = new RunSim(world, header);
  for (const q of inputs) {
    sim.step(q);
    if (sim.finished) {
      const p = sim.progress!;
      return { ok: true, totalMs: Math.round(p.totalMs), lapTimes: p.lapTimes.map((x) => Math.round(x)), ticks: sim.tick };
    }
  }
  return { ok: false, reason: 'run does not finish' };
}

/** FNV-1a over the canonical map JSON — a run only counts against the exact map version it was flown on. */
export function mapHash(m: MapData): string {
  const s = JSON.stringify(m);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(16).padStart(8, '0');
}

export const DT_MS = DT * 1000;

/** Envelope saved as a .dronerun file and uploaded to the leaderboard. */
export interface RunFile {
  kind: 'drone-run';
  v: 1;
  mapId: string;
  mapHash: string;
  mapName: string;
  laps: number;
  mode: FlightMode;
  rates: number;
  player: string;
  ticks: number;
  claimedMs: number;
  lapTimes: number[];
  date: string;
  data: string; // base64(gzip(encodeInputs))
  skin?: unknown;
  attempt?: string; // server-issued attestation id
}
