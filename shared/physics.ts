// Drone flight model. Fixed timestep so behaviour is identical at any frame rate.
//
// "arcade" (default, Bodycam-style): mouse aims, W flies where you look,
//   A/D strafe, Space/C rise/sink. Velocity chases the wished velocity with a
//   stiff exponential response, so it feels instant; the body tilts toward
//   its acceleration purely for looks/feel.
// "acro": real rate-mode quad for gamepad pilots (throttle + pitch/roll/yaw rates).
import { dsin, dcos, dexp, hyp3 } from './dmath.ts';
import { type V3, type Q4, lookDir, rightDir, qEuler, qMul, qAxis, qNorm, qRotate, qYawPitch, clamp, len, dot, wrapAngle } from './math.ts';
import { type World, collideSphere } from './collide.ts';

export const DT = 1 / 120;
export const DRONE_R = 0.35; // world collision radius
export const PILOT_R = 0.6; // drone-vs-drone + hit radius
export const SPEED = 42; // m/s cruise (~150 km/h)
export const BOOST_SPEED = 64; // ~230 km/h
export const ACRO_THRUST = 4 * 9.81;
/** Hard cap any legitimate flight stays below; validators use it. */
export const MAX_SPEED = 75;
export const CRASH_SPEED = 18; // impact speed (m/s, along normal) that counts as a crash

export type FlightMode = 'arcade' | 'acro';

export interface Input {
  mx: number; // strafe -1..1 (right +)
  mz: number; // forward -1..1
  my: number; // vertical -1..1 (arcade) | throttle 0..1 (acro)
  boost: boolean;
  level: boolean; // forward ignores look pitch (straight, level flight)
  // arcade: absolute look angles set by mouse/right stick
  yaw: number;
  pitch: number;
  // acro: stick rates -1..1
  rp: number;
  rr: number;
  ry: number;
}

export const emptyInput = (): Input => ({ mx: 0, mz: 0, my: 0, boost: false, level: false, yaw: 0, pitch: 0, rp: 0, rr: 0, ry: 0 });

export interface DroneState {
  p: V3;
  v: V3;
  q: Q4; // visual/body orientation
  yaw: number; // aim
  pitch: number;
  w: V3; // acro body rates
  boost: number; // 0..1 boost meter
  tilt: [number, number]; // arcade visual tilt (pitch, roll), radians
}

export function newDrone(p: V3, yaw: number): DroneState {
  return { p: [...p] as V3, v: [0, 0, 0], q: qEuler(yaw, 0, 0), yaw, pitch: 0, w: [0, 0, 0], boost: 1, tilt: [0, 0] };
}

export interface StepResult { impact: number; contacts: number }

const expK = (k: number) => 1 - dexp(-k * DT);

export function step(s: DroneState, inp: Input, mode: FlightMode, world: World | null, rates = 1): StepResult {
  const boosting = inp.boost && s.boost > 0.02 && (inp.mz > 0.1 || mode === 'acro');
  s.boost = clamp(s.boost + (boosting ? -DT / 3.5 : DT / 6), 0, 1);

  if (mode === 'arcade') {
    s.yaw = wrapAngle(inp.yaw);
    s.pitch = clamp(inp.pitch, -1.45, 1.45);
    const f = lookDir(s.yaw, inp.level ? 0 : s.pitch);
    const r = rightDir(s.yaw);
    let wx = f[0] * inp.mz + r[0] * inp.mx;
    let wy = f[1] * inp.mz + inp.my;
    let wz = f[2] * inp.mz + r[2] * inp.mx;
    const wl = hyp3(wx, wy, wz);
    if (wl > 1) { wx /= wl; wy /= wl; wz /= wl; }
    const spd = boosting ? BOOST_SPEED : SPEED;
    const tx = wx * spd, ty = wy * spd, tz = wz * spd;
    // Stiffer when accelerating than when coasting, but both are fast — "very responsive".
    const k = expK(wl > 0.05 ? 8.5 : 5.5);
    const ax = (tx - s.v[0]) * k, ay = (ty - s.v[1]) * k, az = (tz - s.v[2]) * k;
    s.v[0] += ax; s.v[1] += ay; s.v[2] += az;
    // Visual tilt: lean into horizontal acceleration expressed in the yaw frame.
    const fwdAcc = (-dsin(s.yaw) * ax - dcos(s.yaw) * az) / DT;
    const rightAcc = (r[0] * ax + r[2] * az) / DT;
    const tp = clamp(-fwdAcc * 0.012, -0.6, 0.6);
    const tr = clamp(-rightAcc * 0.014, -0.6, 0.6);
    const tk = expK(10);
    s.tilt[0] += (tp - s.tilt[0]) * tk;
    s.tilt[1] += (tr - s.tilt[1]) * tk;
    s.q = qEuler(s.yaw, s.tilt[0], s.tilt[1]);
  } else {
    // rate mode: stick -> target body rates, first-order response
    const deg = Math.PI / 180;
    const target: V3 = [-inp.rp * 620 * deg * rates, -inp.ry * 420 * deg * rates, -inp.rr * 620 * deg * rates];
    const k = expK(28);
    for (let i = 0; i < 3; i++) s.w[i] += (target[i] - s.w[i]) * k;
    const wl = len(s.w);
    if (wl > 1e-6) s.q = qNorm(qMul(s.q, qAxis([s.w[0] / wl, s.w[1] / wl, s.w[2] / wl], wl * DT)));
    const up = qRotate(s.q, [0, 1, 0]);
    const thrust = clamp(inp.my, 0, 1) * ACRO_THRUST * (boosting ? 1.35 : 1);
    s.v[0] += up[0] * thrust * DT;
    s.v[1] += (up[1] * thrust - 9.81) * DT;
    s.v[2] += up[2] * thrust * DT;
    const sp = len(s.v);
    const drag = (0.3 + 0.0095 * sp) * DT;
    for (let i = 0; i < 3; i++) s.v[i] -= s.v[i] * drag;
    [s.yaw, s.pitch] = qYawPitch(s.q);
  }

  const sp = len(s.v);
  if (sp > MAX_SPEED) for (let i = 0; i < 3; i++) s.v[i] *= MAX_SPEED / sp;
  s.p[0] += s.v[0] * DT; s.p[1] += s.v[1] * DT; s.p[2] += s.v[2] * DT;

  let impact = 0;
  let contacts = 0;
  if (world) {
    const cs = collideSphere(world, s.p, DRONE_R);
    contacts = cs.length;
    for (const c of cs) {
      const vn = dot(s.v, c.n);
      if (vn < 0) {
        impact = Math.max(impact, -vn);
        // remove inward velocity with a small bounce, and scrub some tangential speed
        for (let i = 0; i < 3; i++) s.v[i] -= c.n[i] * vn * 1.25;
        for (let i = 0; i < 3; i++) s.v[i] *= 0.985;
      }
    }
  }
  return { impact, contacts };
}

/** Elastic-ish sphere push between the local drone and another (only the local one moves). */
export function pushApart(s: DroneState, other: V3, otherV: V3): boolean {
  const dx = s.p[0] - other[0], dy = s.p[1] - other[1], dz = s.p[2] - other[2];
  const d = hyp3(dx, dy, dz);
  const min = PILOT_R * 2;
  if (d >= min || d < 1e-6) return false;
  const n: V3 = [dx / d, dy / d, dz / d];
  for (let i = 0; i < 3; i++) s.p[i] += n[i] * (min - d);
  const rel = (s.v[0] - otherV[0]) * n[0] + (s.v[1] - otherV[1]) * n[1] + (s.v[2] - otherV[2]) * n[2];
  if (rel < 0) for (let i = 0; i < 3; i++) s.v[i] -= n[i] * rel * 1.4;
  return true;
}
