// Deterministic transcendental functions.
//
// ECMAScript leaves Math.sin/cos/exp/atan2/hypot "implementation-approximated",
// so V8 (Chrome, Node) and SpiderMonkey (Firefox) may differ in the last bit.
// For replays to reproduce the exact same time on any browser *and* on the
// server, the simulation only uses + - * / and Math.sqrt (which IEEE 754
// requires to be correctly rounded) via the functions below.
const PI = 3.141592653589793;
const HALF_PI = 1.5707963267948966;
const TWO_PI = 6.283185307179586;
const LN2 = 0.6931471805599453;

function sinPoly(x: number) { // |x| <= pi/4
  const x2 = x * x;
  return x * (1 + x2 * (-1 / 6 + x2 * (1 / 120 + x2 * (-1 / 5040 + x2 * (1 / 362880 + x2 * (-1 / 39916800 + x2 * (1 / 6227020800)))))));
}
function cosPoly(x: number) {
  const x2 = x * x;
  return 1 + x2 * (-1 / 2 + x2 * (1 / 24 + x2 * (-1 / 720 + x2 * (1 / 40320 + x2 * (-1 / 3628800 + x2 * (1 / 479001600 + x2 * (-1 / 87178291200)))))));
}

export function dsin(x: number): number {
  x = x - TWO_PI * Math.floor(x / TWO_PI + 0.5); // [-pi, pi]
  const q = Math.round(x / HALF_PI); // -2..2
  const r = x - q * HALF_PI; // [-pi/4, pi/4]
  switch (((q % 4) + 4) % 4) {
    case 0: return sinPoly(r);
    case 1: return cosPoly(r);
    case 2: return -sinPoly(r);
    default: return -cosPoly(r);
  }
}
export const dcos = (x: number) => dsin(x + HALF_PI);

function atanSmall(x: number) { // |x| <= tan(pi/12)
  const x2 = x * x;
  let s = 0;
  for (let k = 12; k >= 0; k--) s = s * x2 + (k % 2 === 0 ? 1 : -1) / (2 * k + 1);
  return x * s;
}
export function datan(x: number): number {
  if (x < 0) return -datan(-x);
  if (x > 1) return HALF_PI - datan(1 / x);
  const T = 0.2679491924311227; // tan(pi/12)
  if (x > T) {
    const S = 0.5773502691896257; // tan(pi/6) = 1/sqrt(3)
    return PI / 6 + atanSmall((x - S) / (1 + x * S));
  }
  return atanSmall(x);
}
export function datan2(y: number, x: number): number {
  if (x > 0) return datan(y / x);
  if (x < 0) return y >= 0 ? datan(y / x) + PI : datan(y / x) - PI;
  return y > 0 ? HALF_PI : y < 0 ? -HALF_PI : 0;
}
export const dasin = (x: number) => datan2(x, Math.sqrt(Math.max(0, 1 - x * x)));

export function dexp(x: number): number {
  const k = Math.round(x / LN2);
  const r = x - k * LN2;
  let s = 1, t = 1;
  for (let i = 1; i < 20; i++) { t = (t * r) / i; s += t; }
  let p = 1;
  const b = k >= 0 ? 2 : 0.5;
  for (let i = Math.abs(k); i > 0; i--) p *= b;
  return s * p;
}

export const hyp2 = (a: number, b: number) => Math.sqrt(a * a + b * b);
export const hyp3 = (a: number, b: number, c: number) => Math.sqrt(a * a + b * b + c * c);
