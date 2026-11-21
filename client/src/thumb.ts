// Top-down map thumbnail: shaded heightfield + water + objects + course path.
import type { MapData } from '../../shared/map.ts';
import { bakeHeightfield, heightAt, courseLines } from '../../shared/map.ts';

const cache = new Map<string, string>();

export function mapThumb(map: MapData, w = 320, hgt = 200, key?: string): string {
  if (key && cache.has(key)) return cache.get(key)!;
  const hf = bakeHeightfield(map);
  const c = document.createElement('canvas');
  c.width = w; c.height = hgt;
  const g = c.getContext('2d')!;
  const img = g.createImageData(w, hgt);
  const span = map.size * 2;
  const sc = Math.max(span / w, span / hgt);
  const night = map.sky === 'night';
  for (let y = 0; y < hgt; y++) for (let x = 0; x < w; x++) {
    const wx = (x - w / 2) * sc, wz = (y - hgt / 2) * sc;
    const hh = heightAt(hf, wx, wz);
    const shade = (heightAt(hf, wx - sc, wz - sc) - hh) * 0.08;
    let r: number, gg: number, b: number;
    if (map.water !== null && hh < map.water) { r = 40; gg = 100; b = 150; }
    else if (hh > 60) { r = 235; gg = 238; b = 242; }
    else { const t = Math.max(0, Math.min(1, (hh + 10) / 70)); r = 80 + t * 70; gg = 120 + t * 30; b = 60 + t * 40; if (map.ground === 'b:sand') { r = 200; gg = 160; b = 110; } if (map.ground === 'b:snow') { r = 225; gg = 230; b = 238; } if (map.ground === 'b:concrete') { r = 120; gg = 124; b = 130; } }
    const k = night ? 0.45 : 1;
    const i = (y * w + x) * 4;
    img.data[i] = Math.max(0, Math.min(255, (r + shade * 255) * k));
    img.data[i + 1] = Math.max(0, Math.min(255, (gg + shade * 255) * k));
    img.data[i + 2] = Math.max(0, Math.min(255, (b + shade * 255) * k));
    img.data[i + 3] = 255;
  }
  g.putImageData(img, 0, 0);
  const tx = (x: number) => x / sc + w / 2, tz = (z: number) => z / sc + hgt / 2;
  g.fillStyle = 'rgba(0,0,0,.35)';
  for (const o of map.objects) { if (o.t === 'tree') continue; g.fillRect(tx(o.p[0]) - 1.5, tz(o.p[2]) - 1.5, 3, 3); }
  const lines = courseLines(map);
  g.strokeStyle = '#ff7a1a'; g.lineWidth = 2.5; g.lineJoin = 'round';
  g.beginPath();
  lines.forEach((l, i) => (i ? g.lineTo(tx(l.p[0]), tz(l.p[2])) : g.moveTo(tx(l.p[0]), tz(l.p[2]))));
  if (lines.length > 1) g.lineTo(tx(lines[0].p[0]), tz(lines[0].p[2]));
  g.stroke();
  g.fillStyle = '#29d3ff';
  for (const l of map.checkpoints) { g.beginPath(); g.arc(tx(l.p[0]), tz(l.p[2]), 3, 0, 7); g.fill(); }
  g.fillStyle = '#fff';
  g.fillRect(tx(map.start.p[0]) - 4, tz(map.start.p[2]) - 4, 8, 8);
  const url = c.toDataURL('image/jpeg', 0.78);
  if (key) cache.set(key, url);
  return url;
}
