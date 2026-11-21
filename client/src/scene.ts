// Builds a three.js scene from a MapData + its collision World.
import * as THREE from 'three';
import type { MapData, Obj, Line, Sky } from '../../shared/map.ts';
import { CELL, heightAt, courseLines } from '../../shared/map.ts';
import { type World, lineBars, FRAME } from '../../shared/collide.ts';
import { texture, detailTexture } from './textures.ts';

export const SKIES: Record<Sky, { top: number; horizon: number; ground: number; sun: [number, number, number]; sunColor: number; sunI: number; hemi: number; fogFar: number; exposure: number }> = {
  day: { top: 0x3f86d8, horizon: 0xbfdcf2, ground: 0x6d7a5a, sun: [0.45, 0.8, 0.35], sunColor: 0xfff3dd, sunI: 2.4, hemi: 1.1, fogFar: 900, exposure: 1 },
  dusk: { top: 0x2a2f6a, horizon: 0xff9a5a, ground: 0x4a3a33, sun: [-0.7, 0.22, 0.3], sunColor: 0xffb071, sunI: 2.2, hemi: 0.75, fogFar: 750, exposure: 1 },
  night: { top: 0x04050d, horizon: 0x1a1640, ground: 0x0b0a14, sun: [0.2, 0.6, -0.4], sunColor: 0x8aa2ff, sunI: 0.55, hemi: 0.45, fogFar: 600, exposure: 1.1 },
  overcast: { top: 0x8b96a3, horizon: 0xc5ccd3, ground: 0x6a6f66, sun: [0.3, 0.9, 0.2], sunColor: 0xeef2f6, sunI: 1.3, hemi: 1.25, fogFar: 520, exposure: 1 },
};

export type LineState = 'next' | 'later' | 'done' | 'finish';

export interface WorldView {
  scene: THREE.Scene;
  sun: THREE.DirectionalLight;
  lines: { group: THREE.Group; plane: THREE.Mesh; mat: THREE.MeshBasicMaterial }[]; // courseLines order: checkpoints..., start
  setLine(i: number, s: LineState): void;
  update(t: number, camPos: THREE.Vector3): void;
  dispose(): void;
}

const LINE_COLORS: Record<LineState, [number, number]> = { next: [0xffa640, 0.22], later: [0x29d3ff, 0.08], done: [0x29d3ff, 0.03], finish: [0xffffff, 0.3] };

export function buildWorldView(map: MapData, world: World, quality: 'low' | 'med' | 'high', renderer?: THREE.WebGLRenderer): WorldView {
  const scene = new THREE.Scene();
  const sky = SKIES[map.sky];
  scene.fog = new THREE.Fog(sky.horizon, 60, sky.fogFar * (quality === 'low' ? 0.6 : 1));
  scene.background = new THREE.Color(sky.horizon);

  // ---------- sky dome
  const skyGeo = new THREE.SphereGeometry(1800, 32, 16);
  const skyMat = new THREE.ShaderMaterial({
    side: THREE.BackSide, depthWrite: false, fog: false,
    uniforms: { top: { value: new THREE.Color(sky.top) }, hor: { value: new THREE.Color(sky.horizon) }, sunDir: { value: new THREE.Vector3(...sky.sun).normalize() }, sunCol: { value: new THREE.Color(sky.sunColor) } },
    vertexShader: 'varying vec3 vp; void main(){ vp = normalize(position); gl_Position = projectionMatrix * modelViewMatrix * vec4(position,1.0); gl_Position.z = gl_Position.w; }',
    fragmentShader: `uniform vec3 top; uniform vec3 hor; uniform vec3 sunDir; uniform vec3 sunCol; varying vec3 vp;
      void main(){ float h = clamp(vp.y, 0.0, 1.0); vec3 c = mix(hor, top, pow(h, 0.55));
      float s = max(dot(normalize(vp), sunDir), 0.0); c += sunCol * (pow(s, 600.0) * 2.0 + pow(s, 12.0) * 0.18);
      gl_FragColor = vec4(c, 1.0); }`,
  });
  const skyMesh = new THREE.Mesh(skyGeo, skyMat);
  skyMesh.renderOrder = -10;
  scene.add(skyMesh);
  if (map.sky === 'night') {
    const pts = new Float32Array(1500 * 3);
    for (let i = 0; i < 1500; i++) {
      const u = Math.random() * 2 - 1, th = Math.random() * Math.PI * 2, y = Math.abs(u);
      const r = Math.sqrt(1 - y * y);
      pts.set([Math.cos(th) * r * 1700, y * 1700, Math.sin(th) * r * 1700], i * 3);
    }
    const sg = new THREE.BufferGeometry();
    sg.setAttribute('position', new THREE.BufferAttribute(pts, 3));
    skyMesh.add(new THREE.Points(sg, new THREE.PointsMaterial({ color: 0xffffff, size: 2.2, sizeAttenuation: false, fog: false })));
  }

  // ---------- lights
  scene.add(new THREE.HemisphereLight(sky.horizon, sky.ground, sky.hemi));
  const sun = new THREE.DirectionalLight(sky.sunColor, sky.sunI);
  sun.position.set(...(sky.sun.map((x) => x * 300) as [number, number, number]));
  if (quality !== 'low') {
    sun.castShadow = true;
    const sz = quality === 'high' ? 2048 : 1024;
    sun.shadow.mapSize.set(sz, sz);
    const c = sun.shadow.camera;
    c.left = c.bottom = -120; c.right = c.top = 120; c.near = 1; c.far = 900;
    sun.shadow.bias = -0.0004;
    sun.shadow.normalBias = 0.6;
  }
  scene.add(sun, sun.target);

  // ---------- terrain
  const hf = world.hf;
  const step = Math.max(1, Math.ceil((hf.n - 1) / (quality === 'high' ? 320 : quality === 'med' ? 220 : 150)));
  const seg = Math.floor((hf.n - 1) / step);
  const span = seg * step * CELL;
  const tg = new THREE.PlaneGeometry(span, span, seg, seg);
  tg.rotateX(-Math.PI / 2);
  const pos = tg.attributes.position as THREE.BufferAttribute;
  const colors = new Float32Array(pos.count * 3);
  const groundTex = texture(map.ground, renderer);
  const cGrass = new THREE.Color(0x5f8f45), cRock = new THREE.Color(0x857d74), cSnow = new THREE.Color(0xf1f4f8), cSand = new THREE.Color(0xcdb383), cDeep = new THREE.Color(0x3f5f35);
  const tmp = new THREE.Color();
  for (let i = 0; i < pos.count; i++) {
    const wx = pos.getX(i), wz = pos.getZ(i);
    const y = heightAt(hf, wx, wz);
    pos.setXYZ(i, wx, y, wz);
    const sl = Math.abs(heightAt(hf, wx + 2, wz) - heightAt(hf, wx - 2, wz)) + Math.abs(heightAt(hf, wx, wz + 2) - heightAt(hf, wx, wz - 2));
    const steep = THREE.MathUtils.smoothstep(sl, 1.6, 4.5);
    if (groundTex) {
      tmp.setRGB(1, 1, 1).lerp(new THREE.Color(0x8a837a), steep * 0.75);
    } else {
      const water = map.water ?? -1e9;
      tmp.copy(cGrass).lerp(cDeep, THREE.MathUtils.smoothstep(y, 30, 60) * 0.6);
      if (y < water + 1.2) tmp.copy(cSand);
      tmp.lerp(cRock, steep);
      tmp.lerp(cSnow, THREE.MathUtils.smoothstep(y, 55, 75) * (1 - steep * 0.6));
    }
    colors.set([tmp.r, tmp.g, tmp.b], i * 3);
  }
  tg.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  const uv = tg.attributes.uv as THREE.BufferAttribute;
  const rep = span / (groundTex ? 10 : 14);
  for (let i = 0; i < uv.count; i++) uv.setXY(i, uv.getX(i) * rep, uv.getY(i) * rep);
  tg.computeVertexNormals();
  const tmat = new THREE.MeshStandardMaterial({ vertexColors: true, roughness: 0.95, metalness: 0 });
  const tmap = groundTex ?? detailTexture();
  if (tmap) tmat.map = tmap;
  const terrain = new THREE.Mesh(tg, tmat);
  terrain.receiveShadow = quality !== 'low';
  scene.add(terrain);

  // ---------- water
  if (map.water !== null) {
    const wg = new THREE.PlaneGeometry(map.size * 4, map.size * 4);
    wg.rotateX(-Math.PI / 2);
    const wm = new THREE.MeshStandardMaterial({ color: map.sky === 'night' ? 0x0d1b33 : 0x2a6e9e, roughness: 0.15, metalness: 0.2, transparent: true, opacity: 0.82 });
    const w = new THREE.Mesh(wg, wm);
    w.position.y = map.water;
    scene.add(w);
  }

  // ---------- objects
  const objGroup = new THREE.Group();
  scene.add(objGroup);
  addObjects(objGroup, map.objects, map.sky === 'night', quality, renderer);

  // ---------- course lines
  const lines = courseLines(map).map((l, i, arr) => buildLine(l, i === arr.length - 1, map.sky === 'night', world));
  for (const l of lines) scene.add(l.group);

  return {
    scene, sun, lines,
    setLine(i, s) {
      const l = lines[i];
      if (!l) return;
      const [c, o] = i === lines.length - 1 && s !== 'next' ? LINE_COLORS.finish : LINE_COLORS[s];
      l.mat.color.setHex(c);
      l.mat.opacity = o;
    },
    update(t, cam) {
      skyMesh.position.copy(cam);
      sun.position.set(cam.x + sky.sun[0] * 300, cam.y + sky.sun[1] * 300, cam.z + sky.sun[2] * 300);
      sun.target.position.copy(cam);
      const pulse = 0.18 + Math.sin(t * 6) * 0.06;
      for (const l of lines) if (l.mat.color.getHex() === LINE_COLORS.next[0]) l.mat.opacity = pulse;
    },
    dispose() {
      scene.traverse((o) => {
        const m = o as THREE.Mesh;
        m.geometry?.dispose();
        const mats = Array.isArray(m.material) ? m.material : m.material ? [m.material] : [];
        for (const mt of mats) (mt as THREE.Material).dispose();
      });
    },
  };
}

function buildLine(l: Line, isStart: boolean, night: boolean, world: World) {
  const group = new THREE.Group();
  const barMat = isStart
    ? new THREE.MeshStandardMaterial({ map: texture('b:checker', undefined, true), roughness: 0.6 })
    : new THREE.MeshStandardMaterial({ color: night ? 0x29d3ff : 0xff7a1a, emissive: night ? 0x0e5a70 : 0x3a1500, roughness: 0.5 });
  for (const b of lineBars(l, world.hf)) {
    const m = new THREE.Mesh(new THREE.BoxGeometry(...b.s), barMat);
    m.position.set(...b.c);
    m.rotation.y = l.r;
    m.castShadow = true;
    if (isStart && barMat.map) {
      const uvs = m.geometry.attributes.uv as THREE.BufferAttribute;
      for (let i = 0; i < uvs.count; i++) uvs.setXY(i, uvs.getX(i) * Math.max(1, b.s[0] / 2), uvs.getY(i) * Math.max(1, b.s[1] / 2));
    }
    group.add(m);
  }
  const mat = new THREE.MeshBasicMaterial({ color: 0x29d3ff, transparent: true, opacity: 0.08, side: THREE.DoubleSide, depthWrite: false, blending: THREE.AdditiveBlending, fog: false });
  const plane = new THREE.Mesh(new THREE.PlaneGeometry(l.w, l.h), mat);
  plane.position.set(...l.p);
  plane.rotation.y = l.r;
  group.add(plane);
  if (isStart) {
    // banner text
    const c = document.createElement('canvas');
    c.width = 512; c.height = 64;
    const g = c.getContext('2d')!;
    g.fillStyle = '#111'; g.fillRect(0, 0, 512, 64);
    g.fillStyle = '#fff'; g.font = 'bold 40px Chakra Petch, sans-serif'; g.textAlign = 'center'; g.fillText('START  ·  FINISH', 256, 46);
    const t = new THREE.CanvasTexture(c);
    t.colorSpace = THREE.SRGBColorSpace;
    const banner = new THREE.Mesh(new THREE.PlaneGeometry(l.w, l.w / 8), new THREE.MeshBasicMaterial({ map: t, side: THREE.DoubleSide }));
    banner.position.set(l.p[0], l.p[1] + l.h / 2 + FRAME + l.w / 16 + 0.1, l.p[2]);
    banner.rotation.y = l.r;
    group.add(banner);
  }
  return { group, plane, mat };
}

const geoCache = new Map<string, THREE.BufferGeometry>();
const g1 = (k: string, f: () => THREE.BufferGeometry) => { let g = geoCache.get(k); if (!g) { g = f(); geoCache.set(k, g); } return g; };

export function objectMesh(o: Obj, night: boolean, renderer?: THREE.WebGLRenderer): THREE.Object3D {
  const tex = texture(o.tx, renderer);
  const color = new THREE.Color(o.c);
  const mk = (geo: THREE.BufferGeometry, emissive = false) => {
    const mat = new THREE.MeshStandardMaterial({ color: tex ? 0xffffff : color, roughness: 0.85, metalness: o.t === 'cyl' ? 0.2 : 0 });
    if (tex) mat.map = tex;
    if (tex) mat.color = color.clone().lerp(new THREE.Color(0xffffff), 0.6);
    if (emissive) { mat.emissive = color; mat.emissiveIntensity = night ? 1.4 : 0.5; }
    return new THREE.Mesh(geo, mat);
  };
  const [sx, sy, sz] = o.s;
  let obj: THREE.Object3D;
  switch (o.t) {
    case 'box':
    case 'pad': {
      const geo = new THREE.BoxGeometry(sx, sy, sz);
      if (tex) {
        // tile textures by world size per face
        const uv = geo.attributes.uv as THREE.BufferAttribute;
        const faces = [[sz, sy], [sz, sy], [sx, sz], [sx, sz], [sx, sy], [sx, sy]];
        for (let f = 0; f < 6; f++) for (let k = 0; k < 4; k++) { const i = f * 4 + k; uv.setXY(i, uv.getX(i) * faces[f][0] / 4, uv.getY(i) * faces[f][1] / 4); }
      }
      obj = mk(geo);
      obj.position.set(o.p[0], o.p[1] + sy / 2, o.p[2]);
      break;
    }
    case 'cyl':
      obj = mk(new THREE.CylinderGeometry(sx / 2, sx / 2, sy, 20));
      obj.position.set(o.p[0], o.p[1] + sy / 2, o.p[2]);
      break;
    case 'tree': {
      const grp = new THREE.Group();
      const trunk = new THREE.Mesh(g1('trunk', () => new THREE.CylinderGeometry(0.5, 0.7, 1, 6)), new THREE.MeshStandardMaterial({ color: 0x5a3f2a, roughness: 1 }));
      const tr = Math.max(0.25, sx * 0.08);
      trunk.scale.set(tr * 2, sy * 0.35, tr * 2);
      trunk.position.y = sy * 0.175;
      const leaves = mk(g1('cone', () => new THREE.ConeGeometry(1, 1, 8)));
      leaves.scale.set(sx * 0.5, sy * 0.7, sx * 0.5);
      leaves.position.y = sy * 0.3 + sy * 0.35;
      grp.add(trunk, leaves);
      obj = grp;
      obj.position.set(...o.p);
      break;
    }
    case 'rock': {
      obj = mk(g1('rock', () => new THREE.DodecahedronGeometry(1, 0)));
      obj.scale.set(sx / 2, sx / 2 * 0.85, sx / 2);
      obj.position.set(o.p[0], o.p[1] + sx / 4, o.p[2]);
      obj.rotation.set(o.p[0] % 3, o.p[2] % 3, 0);
      break;
    }
    case 'ring': {
      const R = sx / 2, r = Math.max(0.2, sz * 0.08);
      obj = mk(new THREE.TorusGeometry(R, r, 10, 48), true);
      obj.position.set(...o.p);
      break;
    }
  }
  obj.rotation.y = o.t === 'rock' ? obj.rotation.y : o.r;
  obj.traverse((m) => { if ((m as THREE.Mesh).isMesh) { m.castShadow = true; m.receiveShadow = true; } });
  obj.userData.obj = o;
  return obj;
}

export function addObjects(group: THREE.Group, objs: Obj[], night: boolean, _q: string, renderer?: THREE.WebGLRenderer) {
  for (const o of objs) group.add(objectMesh(o, night, renderer));
}
