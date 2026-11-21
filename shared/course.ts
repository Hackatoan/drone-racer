// Lap/checkpoint progress. Runs inside the deterministic RunSim (time trials,
// replayed bit-for-bit by the server) and on the server for live races.
import { dsin, dcos } from './dmath.ts';
import type { V3 } from './math.ts';
import { type MapData, type Line, courseLines } from './map.ts';

export const lineForward = (l: Line): V3 => [-dsin(l.r), 0, -dcos(l.r)];

/** Fraction along a→b where it crosses the line front-to-back through the opening, or -1. */
export function crossLine(l: Line, a: V3, b: V3): number {
  const n = lineForward(l);
  const da = (a[0] - l.p[0]) * n[0] + (a[2] - l.p[2]) * n[2];
  const db = (b[0] - l.p[0]) * n[0] + (b[2] - l.p[2]) * n[2];
  if (!(da < 0 && db >= 0)) return -1;
  const t = da / (da - db);
  const x = a[0] + (b[0] - a[0]) * t, y = a[1] + (b[1] - a[1]) * t, z = a[2] + (b[2] - a[2]) * t;
  const rx = dcos(l.r), rz = -dsin(l.r);
  const lateral = (x - l.p[0]) * rx + (z - l.p[2]) * rz;
  if (Math.abs(lateral) > l.w / 2 + 0.3) return -1;
  if (Math.abs(y - l.p[1]) > l.h / 2 + 0.3) return -1;
  return t;
}

export type ProgressEvent =
  | { e: 'start'; t: number }
  | { e: 'checkpoint'; idx: number; t: number }
  | { e: 'lap'; lap: number; lapMs: number; t: number }
  | { e: 'finish'; totalMs: number; t: number };

export class Progress {
  lines: Line[];
  started = false;
  finished = false;
  lap = 0; // current lap, 1-based once started
  next = 0; // index into lines
  startT = 0; // ms
  lapStartT = 0;
  lapTimes: number[] = [];
  totalMs = 0;
  lastLine: Line | null = null;

  constructor(public map: MapData, public laps: number) {
    this.lines = courseLines(map);
  }

  get checkpointCount() { return this.map.checkpoints.length; }

  /** Feed one movement segment ending at time tB (ms); a→b over [tA, tB]. */
  feed(a: V3, b: V3, tA: number, tB: number): ProgressEvent[] {
    if (this.finished) return [];
    const ev: ProgressEvent[] = [];
    const at = (f: number) => tA + (tB - tA) * f;
    if (!this.started) {
      const f = crossLine(this.map.start, a, b);
      if (f >= 0) {
        this.started = true;
        this.lap = 1;
        this.next = 0;
        this.startT = this.lapStartT = at(f);
        this.lastLine = this.map.start;
        ev.push({ e: 'start', t: this.startT });
      }
      return ev;
    }
    const line = this.lines[this.next];
    const f = crossLine(line, a, b);
    if (f < 0) return ev;
    const t = at(f);
    this.lastLine = line;
    if (this.next < this.lines.length - 1) {
      ev.push({ e: 'checkpoint', idx: this.next, t });
      this.next++;
      return ev;
    }
    const lapMs = t - this.lapStartT;
    this.lapTimes.push(lapMs);
    ev.push({ e: 'lap', lap: this.lap, lapMs, t });
    if (this.lap >= this.laps) {
      this.finished = true;
      this.totalMs = t - this.startT;
      ev.push({ e: 'finish', totalMs: this.totalMs, t });
    } else {
      this.lap++;
      this.next = 0;
      this.lapStartT = t;
    }
    return ev;
  }

  /** Where a crash puts you back: just past the last line crossed. */
  respawnPoint(fallback: { p: V3; r: number }): { p: V3; r: number } {
    const l = this.lastLine;
    if (!l) return fallback;
    const f = lineForward(l);
    return { p: [l.p[0] + f[0] * 2, l.p[1], l.p[2] + f[2] * 2], r: l.r };
  }
}
