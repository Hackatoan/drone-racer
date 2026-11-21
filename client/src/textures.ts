// Built-in textures are painted procedurally on canvases (no assets to ship);
// uploaded ones (u:<id>) stream from the server.
import * as THREE from 'three';
import { mulberry32 } from '../../shared/rng.ts';
import { BUILTIN_TEXTURES } from '../../shared/map.ts';

const cache = new Map<string, THREE.Texture>();
const S = 256;

function paint(name: string): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const rnd = mulberry32(name.split('').reduce((a, ch) => a * 31 + ch.charCodeAt(0), 7));
  const noise = (base: [number, number, number], amt: number, blotch = 0) => {
    const img = g.createImageData(S, S);
    const blot = new Float32Array(S * S);
    if (blotch) for (let i = 0; i < 40; i++) {
      const cx = rnd() * S, cy = rnd() * S, r = 10 + rnd() * 40, v = (rnd() - 0.5) * blotch;
      for (let y = -r; y < r; y++) for (let x = -r; x < r; x++) {
        const d = Math.hypot(x, y) / r;
        if (d < 1) blot[((Math.floor(cy + y) + S) % S) * S + ((Math.floor(cx + x) + S) % S)] += v * (1 - d);
      }
    }
    for (let i = 0; i < S * S; i++) {
      const n = (rnd() - 0.5) * amt + blot[i];
      img.data[i * 4] = base[0] + n; img.data[i * 4 + 1] = base[1] + n; img.data[i * 4 + 2] = base[2] + n; img.data[i * 4 + 3] = 255;
    }
    g.putImageData(img, 0, 0);
  };
  switch (name) {
    case 'grass': noise([88, 140, 70], 40, 40); for (let i = 0; i < 900; i++) { g.fillStyle = `rgba(${40 + rnd() * 60},${110 + rnd() * 70},${40 + rnd() * 30},.5)`; g.fillRect(rnd() * S, rnd() * S, 1, 3 + rnd() * 4); } break;
    case 'dirt': noise([120, 92, 64], 50, 50); break;
    case 'sand': noise([214, 186, 136], 26, 24); break;
    case 'snow': noise([236, 240, 247], 14, 14); break;
    case 'rock': noise([118, 114, 110], 60, 60); g.strokeStyle = 'rgba(40,40,40,.35)'; for (let i = 0; i < 14; i++) { g.beginPath(); g.moveTo(rnd() * S, rnd() * S); g.lineTo(rnd() * S, rnd() * S); g.stroke(); } break;
    case 'concrete': noise([150, 152, 156], 22, 20); g.strokeStyle = 'rgba(0,0,0,.25)'; g.lineWidth = 2; g.strokeRect(1, 1, S - 2, S - 2); break;
    case 'brick': {
      g.fillStyle = '#bfb7ad'; g.fillRect(0, 0, S, S);
      const bh = 32, bw = 64;
      for (let y = 0; y < S; y += bh) for (let x = -bw; x < S; x += bw) {
        const off = (y / bh) % 2 ? bw / 2 : 0;
        g.fillStyle = `rgb(${150 + rnd() * 40},${60 + rnd() * 20},${45 + rnd() * 15})`;
        g.fillRect(x + off + 2, y + 2, bw - 4, bh - 4);
      }
      break;
    }
    case 'wood': for (let y = 0; y < S; y++) { const v = 110 + 30 * Math.sin(y * 0.35 + Math.sin(y * 0.05) * 4) + (rnd() - 0.5) * 20; g.fillStyle = `rgb(${v + 40},${v},${v * 0.6})`; g.fillRect(0, y, S, 1); } break;
    case 'metal': noise([150, 156, 165], 18); g.strokeStyle = 'rgba(255,255,255,.08)'; for (let y = 0; y < S; y += 2) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y + rnd() * 2); g.stroke(); } g.fillStyle = 'rgba(0,0,0,.35)'; for (const [x, y] of [[16, 16], [240, 16], [16, 240], [240, 240]]) { g.beginPath(); g.arc(x, y, 5, 0, 7); g.fill(); } break;
    case 'checker': for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) { g.fillStyle = (x + y) % 2 ? '#111' : '#f2f2f2'; g.fillRect(x * 32, y * 32, 32, 32); } break;
    case 'neon': g.fillStyle = '#07060d'; g.fillRect(0, 0, S, S); g.strokeStyle = '#ff2bd6'; g.lineWidth = 3; g.shadowColor = '#ff2bd6'; g.shadowBlur = 12; for (let i = 0; i <= S; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i, S); g.moveTo(0, i); g.lineTo(S, i); g.stroke(); } break;
    case 'ice': noise([190, 224, 245], 20, 30); g.strokeStyle = 'rgba(255,255,255,.5)'; for (let i = 0; i < 20; i++) { g.beginPath(); g.moveTo(rnd() * S, rnd() * S); g.lineTo(rnd() * S, rnd() * S); g.stroke(); } break;
    case 'lava': noise([60, 20, 14], 30, 30); g.strokeStyle = '#ff6a00'; g.shadowColor = '#ffae00'; g.shadowBlur = 10; g.lineWidth = 4; for (let i = 0; i < 16; i++) { g.beginPath(); let x = rnd() * S, y = rnd() * S; g.moveTo(x, y); for (let k = 0; k < 5; k++) { x += (rnd() - 0.5) * 80; y += (rnd() - 0.5) * 80; g.lineTo(x, y); } g.stroke(); } break;
    case 'hazard': g.fillStyle = '#ffcc00'; g.fillRect(0, 0, S, S); g.fillStyle = '#111'; for (let i = -S; i < S * 2; i += 64) { g.beginPath(); g.moveTo(i, 0); g.lineTo(i + 32, 0); g.lineTo(i + 32 - S, S); g.lineTo(i - S, S); g.fill(); } break;
    default: noise([128, 128, 128], 30);
  }
  return c;
}

/** 'all' | 'builtin' (skip custom uploads) | 'none' (flat colors) — for slower machines. */
export type TexturePolicy = 'all' | 'builtin' | 'none';
let policy: TexturePolicy = 'all';
export const setTexturePolicy = (p: TexturePolicy) => { policy = p; };

export function texture(key: string | undefined, renderer?: THREE.WebGLRenderer, force = false): THREE.Texture | null {
  if (!key) return null;
  if (!force && (policy === 'none' || (policy === 'builtin' && key.startsWith('u:')))) return null;
  const hit = cache.get(key);
  if (hit) return hit;
  let t: THREE.Texture;
  if (key.startsWith('b:') && (BUILTIN_TEXTURES as readonly string[]).includes(key.slice(2))) {
    t = new THREE.CanvasTexture(paint(key.slice(2)));
  } else if (key.startsWith('u:')) {
    t = new THREE.TextureLoader().load(`/api/textures/${key.slice(2)}`);
  } else return null;
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = renderer ? Math.min(8, renderer.capabilities.getMaxAnisotropy()) : 4;
  cache.set(key, t);
  return t;
}

/** Small preview swatch (data URL) for pickers. */
const swatchCache = new Map<string, string>();
export function swatch(key: string): string {
  if (key.startsWith('u:')) return `/api/textures/${key.slice(2)}`;
  let s = swatchCache.get(key);
  if (!s) { s = paint(key.slice(2)).toDataURL('image/png'); swatchCache.set(key, s); }
  return s;
}

/** Grayscale detail noise used under vertex-colored terrain. */
let detail: THREE.Texture | null = null;
export function detailTexture() {
  if (policy === 'none') return null;
  if (detail) return detail;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const g = c.getContext('2d')!;
  const img = g.createImageData(S, S);
  const rnd = mulberry32(99);
  for (let i = 0; i < S * S; i++) { const v = 200 + rnd() * 55; img.data[i * 4] = img.data[i * 4 + 1] = img.data[i * 4 + 2] = v; img.data[i * 4 + 3] = 255; }
  g.putImageData(img, 0, 0);
  detail = new THREE.CanvasTexture(c);
  detail.wrapS = detail.wrapT = THREE.RepeatWrapping;
  detail.colorSpace = THREE.SRGBColorSpace;
  return detail;
}
