// Tiny allocation-light vector/quaternion helpers shared by client and server.
// Plain tuples keep the server free of a three.js dependency.
import { dsin, dcos, datan2, dasin, hyp3 } from './dmath.ts';

export type V3 = [number, number, number];
export type Q4 = [number, number, number, number]; // x, y, z, w

export const v3 = (x = 0, y = 0, z = 0): V3 => [x, y, z];
export const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
export const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
export const scale = (a: V3, s: number): V3 => [a[0] * s, a[1] * s, a[2] * s];
export const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
export const cross = (a: V3, b: V3): V3 => [
  a[1] * b[2] - a[2] * b[1],
  a[2] * b[0] - a[0] * b[2],
  a[0] * b[1] - a[1] * b[0],
];
export const len = (a: V3) => hyp3(a[0], a[1], a[2]);
export const dist = (a: V3, b: V3) => hyp3(a[0] - b[0], a[1] - b[1], a[2] - b[2]);
export const norm = (a: V3): V3 => {
  const l = len(a);
  return l > 1e-9 ? [a[0] / l, a[1] / l, a[2] / l] : [0, 0, 0];
};
export const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
export const lerp3 = (a: V3, b: V3, t: number): V3 => [lerp(a[0], b[0], t), lerp(a[1], b[1], t), lerp(a[2], b[2], t)];
export const clamp = (x: number, lo: number, hi: number) => (x < lo ? lo : x > hi ? hi : x);

/** Direction the camera faces for a yaw/pitch pair. yaw=0 looks down -Z (three.js convention). */
export function lookDir(yaw: number, pitch: number): V3 {
  const cp = dcos(pitch);
  return [-dsin(yaw) * cp, dsin(pitch), -dcos(yaw) * cp];
}

/** Horizontal right vector for a yaw. */
export const rightDir = (yaw: number): V3 => [dcos(yaw), 0, -dsin(yaw)];

export function qMul(a: Q4, b: Q4): Q4 {
  const [ax, ay, az, aw] = a, [bx, by, bz, bw] = b;
  return [
    aw * bx + ax * bw + ay * bz - az * by,
    aw * by - ax * bz + ay * bw + az * bx,
    aw * bz + ax * by - ay * bx + az * bw,
    aw * bw - ax * bx - ay * by - az * bz,
  ];
}
export function qAxis(axis: V3, angle: number): Q4 {
  const s = dsin(angle / 2);
  return [axis[0] * s, axis[1] * s, axis[2] * s, dcos(angle / 2)];
}
export function qNorm(q: Q4): Q4 {
  const l = Math.sqrt(q[0] * q[0] + q[1] * q[1] + q[2] * q[2] + q[3] * q[3]) || 1;
  return [q[0] / l, q[1] / l, q[2] / l, q[3] / l];
}
export function qRotate(q: Q4, v: V3): V3 {
  const [x, y, z, w] = q;
  const ix = w * v[0] + y * v[2] - z * v[1];
  const iy = w * v[1] + z * v[0] - x * v[2];
  const iz = w * v[2] + x * v[1] - y * v[0];
  const iw = -x * v[0] - y * v[1] - z * v[2];
  return [
    ix * w + iw * -x + iy * -z - iz * -y,
    iy * w + iw * -y + iz * -x - ix * -z,
    iz * w + iw * -z + ix * -y - iy * -x,
  ];
}
/** Yaw (about Y) then pitch (about X) then roll (about Z), intrinsic. */
export function qEuler(yaw: number, pitch: number, roll: number): Q4 {
  return qMul(qMul(qAxis([0, 1, 0], yaw), qAxis([1, 0, 0], pitch)), qAxis([0, 0, 1], roll));
}
/** Recover yaw/pitch of a quaternion's forward (-Z) axis. */
export function qYawPitch(q: Q4): [number, number] {
  const f = qRotate(q, [0, 0, -1]);
  return [datan2(-f[0], -f[2]), dasin(clamp(f[1], -1, 1))];
}
export const wrapAngle = (a: number) => {
  while (a > Math.PI) a -= Math.PI * 2;
  while (a < -Math.PI) a += Math.PI * 2;
  return a;
};
