// Procedural drone models (3 frames) with skin colors, decals and optional
// premium texture. Forward is -Z, matching the physics.
import * as THREE from 'three';
import type { Skin } from '../../shared/skins.ts';
import { texture } from './textures.ts';

export interface DroneMesh {
  group: THREE.Group;
  body: THREE.Object3D;
  update(dt: number, throttle: number): void;
  setOpacity(o: number): void;
  dispose(): void;
}

const decalCache = new Map<string, THREE.Texture>();

function decalTexture(s: Skin): THREE.Texture {
  const key = `${s.decal}|${s.body}|${s.accent}`;
  const hit = decalCache.get(key);
  if (hit) return hit;
  const c = document.createElement('canvas');
  c.width = c.height = 256;
  const g = c.getContext('2d')!;
  g.fillStyle = s.body; g.fillRect(0, 0, 256, 256);
  g.fillStyle = s.accent; g.strokeStyle = s.accent;
  switch (s.decal) {
    case 'stripes': for (let i = 0; i < 3; i++) g.fillRect(90 + i * 30, 0, 14, 256); break;
    case 'carbon': for (let y = 0; y < 256; y += 8) for (let x = 0; x < 256; x += 8) { g.fillStyle = (x + y) % 16 ? 'rgba(255,255,255,.08)' : 'rgba(0,0,0,.25)'; g.fillRect(x, y, 8, 8); } g.fillStyle = s.accent; g.fillRect(0, 120, 256, 16); break;
    case 'camo': for (let i = 0; i < 40; i++) { g.globalAlpha = 0.6; g.beginPath(); g.ellipse(Math.random() * 256, Math.random() * 256, 20 + Math.random() * 30, 10 + Math.random() * 20, Math.random() * 3, 0, 7); g.fill(); } g.globalAlpha = 1; break;
    case 'flames': g.beginPath(); g.moveTo(0, 256); for (let x = 0; x <= 256; x += 32) { g.lineTo(x + 16, 90 + Math.random() * 40); g.lineTo(x + 32, 200); } g.lineTo(256, 256); g.fill(); break;
    case 'checker': for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if ((x + y) % 2) g.fillRect(x * 32, y * 32, 32, 32); break;
    case 'hex': g.lineWidth = 3; for (let y = 0; y < 300; y += 26) for (let x = 0; x < 300; x += 45) { const ox = (y / 26) % 2 ? 22 : 0; g.beginPath(); for (let k = 0; k < 6; k++) { const a = (k / 6) * Math.PI * 2; g.lineTo(x + ox + Math.cos(a) * 14, y + Math.sin(a) * 14); } g.closePath(); g.stroke(); } break;
    case 'splat': for (let i = 0; i < 12; i++) { g.beginPath(); g.arc(Math.random() * 256, Math.random() * 256, 6 + Math.random() * 24, 0, 7); g.fill(); } break;
  }
  const t = new THREE.CanvasTexture(c);
  t.colorSpace = THREE.SRGBColorSpace;
  decalCache.set(key, t);
  return t;
}

export function buildDrone(skin: Skin, opts: { ghost?: number; guns?: boolean; teamColor?: number } = {}): DroneMesh {
  const group = new THREE.Group();
  const frame = new THREE.Group();
  group.add(frame);
  const ghost = opts.ghost !== undefined;
  const mats: THREE.Material[] = [];
  const std = (p: THREE.MeshStandardMaterialParameters) => {
    const m = new THREE.MeshStandardMaterial({ roughness: 0.5, metalness: 0.2, ...p });
    if (ghost) { m.transparent = true; m.opacity = 0.35; m.depthWrite = false; if (opts.ghost) { m.color = new THREE.Color(opts.ghost); m.map = null; m.emissive = new THREE.Color(opts.ghost).multiplyScalar(0.4); } }
    mats.push(m);
    return m;
  };
  const bodyMap = (skin.tex ? texture(skin.tex) : null) ?? decalTexture(skin);
  const bodyMat = std({ map: bodyMap, color: 0xffffff });
  const armMat = std({ color: new THREE.Color(skin.body).multiplyScalar(0.6), roughness: 0.7 });
  const accentMat = std({ color: skin.accent });
  const propMat = std({ color: skin.props, transparent: true, opacity: ghost ? 0.25 : 0.75, side: THREE.DoubleSide });
  const ledMat = new THREE.MeshBasicMaterial({ color: opts.teamColor ?? skin.led, transparent: ghost, opacity: ghost ? 0.5 : 1 });
  mats.push(ledMat);

  const f = skin.frame;
  const arm = f === 'whoop' ? 0.2 : f === 'heavy' ? 0.33 : 0.3;
  const propR = f === 'whoop' ? 0.13 : f === 'heavy' ? 0.17 : 0.15;
  const bodyDims: [number, number, number] = f === 'heavy' ? [0.26, 0.12, 0.36] : f === 'whoop' ? [0.16, 0.07, 0.2] : [0.14, 0.06, 0.3];
  const body = new THREE.Mesh(new THREE.BoxGeometry(...bodyDims), bodyMat);
  body.position.y = 0.03;
  frame.add(body);
  // camera pod
  const cam = new THREE.Mesh(new THREE.BoxGeometry(0.07, 0.06, 0.06), std({ color: 0x111111 }));
  cam.position.set(0, 0.07, -bodyDims[2] / 2 + 0.03);
  const lens = new THREE.Mesh(new THREE.CircleGeometry(0.022, 16), new THREE.MeshBasicMaterial({ color: 0x223355 }));
  lens.position.set(0, 0.07, -bodyDims[2] / 2 - 0.001);
  lens.rotation.y = Math.PI;
  frame.add(cam, lens);
  // antenna
  const ant = new THREE.Mesh(new THREE.CylinderGeometry(0.006, 0.006, 0.14), accentMat);
  ant.position.set(0, 0.1, bodyDims[2] / 2 - 0.02);
  ant.rotation.x = 0.5;
  frame.add(ant);

  const props: THREE.Object3D[] = [];
  const diag = [[1, -1], [-1, -1], [1, 1], [-1, 1]];
  for (const [sx, sz] of diag) {
    const ax = sx * arm * 0.7071, az = sz * arm * 0.7071;
    const armGeo = new THREE.BoxGeometry(f === 'heavy' ? 0.05 : 0.03, 0.02, arm);
    const a = new THREE.Mesh(armGeo, armMat);
    a.position.set(ax / 2, 0, az / 2);
    a.rotation.y = Math.atan2(ax, az);
    frame.add(a);
    const motor = new THREE.Mesh(new THREE.CylinderGeometry(0.028, 0.028, 0.04, 12), accentMat);
    motor.position.set(ax, 0.02, az);
    frame.add(motor);
    const prop = new THREE.Group();
    const blade = new THREE.Mesh(new THREE.BoxGeometry(propR * 2, 0.004, 0.025), propMat);
    const blade2 = blade.clone();
    blade2.rotation.y = Math.PI / 2;
    prop.add(blade, blade2);
    const disc = new THREE.Mesh(new THREE.CircleGeometry(propR, 20), propMat);
    disc.rotation.x = -Math.PI / 2;
    disc.visible = false;
    disc.name = 'disc';
    prop.add(disc);
    prop.position.set(ax, 0.045, az);
    prop.userData.dir = sx * sz;
    frame.add(prop);
    props.push(prop);
    if (f === 'whoop') {
      const duct = new THREE.Mesh(new THREE.TorusGeometry(propR + 0.012, 0.012, 6, 24), armMat);
      duct.rotation.x = Math.PI / 2;
      duct.position.copy(prop.position);
      frame.add(duct);
    }
    // LEDs under the arms
    const led = new THREE.Mesh(new THREE.SphereGeometry(0.015, 8, 6), ledMat);
    led.position.set(ax * 0.6, -0.015, az * 0.6);
    frame.add(led);
  }
  if (opts.guns || f === 'heavy') {
    for (const sx of [-1, 1]) {
      const g = new THREE.Mesh(new THREE.CylinderGeometry(0.015, 0.015, 0.22, 8), std({ color: 0x2a2a2a, metalness: 0.7 }));
      g.rotation.x = Math.PI / 2;
      g.position.set(sx * (bodyDims[0] / 2 + 0.02), -0.02, -0.12);
      frame.add(g);
    }
  }
  // light the drone visually at scale; physical radius is 0.35 m
  frame.scale.setScalar(1.1);
  group.traverse((m) => { if ((m as THREE.Mesh).isMesh) (m as THREE.Mesh).castShadow = !ghost; });

  let spin = 0;
  return {
    group, body,
    update(dt, throttle) {
      spin += dt * (30 + throttle * 90);
      const fast = throttle > 0.05 || true;
      for (const p of props) {
        p.rotation.y = spin * p.userData.dir;
        const disc = p.getObjectByName('disc');
        if (disc) disc.visible = fast;
        p.children[0].visible = p.children[1].visible = !fast;
      }
    },
    setOpacity(o) { for (const m of mats) { m.transparent = o < 1 || m.transparent; m.opacity = o; } },
    dispose() { group.traverse((m) => (m as THREE.Mesh).geometry?.dispose()); for (const m of mats) m.dispose(); },
  };
}

export const GHOST_COLORS = { pb: 0x29d3ff, wr: 0xffd54a, author: 0x2ef2c1, other: 0xc58bff };
export const TEAM_COLORS = [0xffffff, 0xff4d5e, 0x3d8bff];
