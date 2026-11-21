// Map editor: orbit view, placement tools, transform gizmo, terrain brushes,
// inspector, test-fly → validate → publish.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { TransformControls } from 'three/examples/jsm/controls/TransformControls.js';
import { h, clear, put, toast, modal, fmtMs } from '../dom.ts';
import { me } from '../state.ts';
import { api } from '../api.ts';
import { go, app, doSignIn } from './app.ts';
import { renderer, camera, Session } from '../game.ts';
import { buildWorldView, type WorldView } from '../scene.ts';
import { swatch } from '../textures.ts';
import { uploadTexture, mapDetail } from './screens.ts';
import { mapThumb } from '../thumb.ts';
import { download, pickFile } from '../runfile.ts';
import { type MapData, type Obj, type ObjType, type Line, emptyMap, sanitizeMap, heightAt, defaultColor, BUILTIN_TEXTURES, LIMITS } from '../../../shared/map.ts';
import { buildWorld, type World } from '../../../shared/collide.ts';
import { mapHash, type RunFile, replayRun } from '../../../shared/replay.ts';
import { autopilot } from '../../../shared/mapgen.ts';
import type { V3 } from '../../../shared/math.ts';

type Tool = 'select' | 'start' | 'checkpoint' | ObjType | 'spawn' | 'raise' | 'lower' | 'flatten' | 'smooth';
type Sel = { k: 'obj'; i: number } | { k: 'cp'; i: number } | { k: 'start' } | { k: 'spawn'; i: number } | null;

const DRAFT = 'drone.draft.v1';

export function openEditor(initial: MapData | null, back: () => HTMLElement) {
  let map: MapData;
  if (initial) map = sanitizeMap(initial);
  else {
    let draft: MapData | null = null;
    try { const raw = localStorage.getItem(DRAFT); if (raw) draft = sanitizeMap(JSON.parse(raw)); } catch { /* ignore */ }
    map = draft ?? starterMap();
  }
  new Editor(map, back);
}

/** A small 4-line loop on flattened ground so a new map is flyable immediately. */
function starterMap(): MapData {
  const m = emptyMap();
  m.terrain.amp = 10;
  const pts: [number, number][] = [[0, 70], [70, -10], [0, -80], [-70, -10]];
  const lines: Line[] = pts.map(([x, z], i) => {
    const prev = pts[(i + pts.length - 1) % pts.length], next = pts[(i + 1) % pts.length];
    return { p: [x, 5, z], r: r3(Math.atan2(-(next[0] - prev[0]), -(next[1] - prev[1]))), w: i ? 10 : 12, h: 7 };
  });
  m.start = lines[0];
  m.checkpoints = lines.slice(1);
  m.terrain.brushes = [[0, 0, 120, 0, 1]];
  return m;
}

class Editor {
  world!: World;
  view!: WorldView;
  orbit: OrbitControls;
  gizmo: TransformControls;
  pivot = new THREE.Object3D();
  tool: Tool = 'select';
  sel: Sel = null;
  brush = { r: 18, s: 3 };
  undo: string[] = [];
  redo: string[] = [];
  validRun: RunFile | null = null;
  raf = 0;
  alive = true;
  root!: HTMLElement;
  right!: HTMLElement;
  status!: HTMLElement;
  cursor: THREE.Mesh;
  painting = false;
  lastPaint = 0;
  dirtyTerrain = false;
  rebuildT = 0;
  ray = new THREE.Raycaster();
  textures: string[] = BUILTIN_TEXTURES.map((t) => `b:${t}`);

  constructor(public map: MapData, public back: () => HTMLElement) {
    camera.fov = 60;
    camera.position.set(0, 95, 150);
    camera.updateProjectionMatrix();
    this.orbit = new OrbitControls(camera, renderer.domElement);
    this.orbit.target.set(0, 0, 0);
    this.orbit.mouseButtons = { LEFT: null as any, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.ROTATE };
    this.orbit.maxDistance = 1400;
    this.orbit.update();
    this.gizmo = new TransformControls(camera, renderer.domElement);
    this.gizmo.addEventListener('dragging-changed', (e: any) => {
      this.orbit.enabled = !e.value;
      if (!e.value) this.commitPivot();
      else this.snapshot();
    });
    this.gizmo.addEventListener('objectChange', () => this.livePivot());
    this.cursor = new THREE.Mesh(new THREE.RingGeometry(0.95, 1, 48), new THREE.MeshBasicMaterial({ color: 0xff7a1a, side: THREE.DoubleSide, depthTest: false, transparent: true }));
    this.cursor.rotation.x = -Math.PI / 2;
    this.cursor.renderOrder = 10;
    this.rebuild();
    this.buildUi();
    renderer.domElement.addEventListener('pointerdown', this.onDown);
    addEventListener('pointermove', this.onMove);
    addEventListener('pointerup', this.onUp);
    addEventListener('keydown', this.onKey);
    if (me.uid) api<{ textures: { key: string }[] }>('/textures?mine=1').then((r) => { this.textures.push(...r.textures.map((t) => t.key)); this.renderRight(); }).catch(() => {});
    this.raf = requestAnimationFrame(this.loop);
  }

  // ------------------------------------------------------------ scene

  rebuild() {
    this.map = sanitizeMap(this.map);
    this.view?.dispose();
    this.world = buildWorld(this.map);
    this.view = buildWorldView(this.map, this.world, 'med', renderer);
    this.view.scene.add(this.pivot, this.gizmo.getHelper(), this.cursor);
    for (let i = 0; i < this.view.lines.length; i++) this.view.setLine(i, i === this.view.lines.length - 1 ? 'finish' : 'later');
    // spawns as small cones
    for (const s of this.map.spawns) {
      const c = new THREE.Mesh(new THREE.ConeGeometry(1, 2.5, 8), new THREE.MeshBasicMaterial({ color: 0x3ddc84 }));
      c.position.set(...s.p);
      c.rotation.x = -Math.PI / 2;
      c.rotation.z = -s.r;
      this.view.scene.add(c);
    }
    // checkpoint numbers
    this.map.checkpoints.forEach((c, i) => this.view.scene.add(label(String(i + 1), c)));
    this.reattach();
    try { localStorage.setItem(DRAFT, JSON.stringify(this.map)); } catch { /* quota */ }
    this.updateStatus();
  }

  scheduleRebuild(ms = 120) { clearTimeout(this.rebuildT); this.rebuildT = window.setTimeout(() => this.rebuild(), ms); }

  snapshot() { this.undo.push(JSON.stringify(this.map)); if (this.undo.length > 60) this.undo.shift(); this.redo = []; }
  doUndo() { const s = this.undo.pop(); if (!s) return; this.redo.push(JSON.stringify(this.map)); this.map = JSON.parse(s); this.sel = null; this.rebuild(); this.renderRight(); }
  doRedo() { const s = this.redo.pop(); if (!s) return; this.undo.push(JSON.stringify(this.map)); this.map = JSON.parse(s); this.sel = null; this.rebuild(); this.renderRight(); }

  // ------------------------------------------------------------ selection / gizmo

  selItem(): { p: V3; r?: number } | null {
    const s = this.sel;
    if (!s) return null;
    if (s.k === 'obj') return this.map.objects[s.i] ?? null;
    if (s.k === 'cp') return this.map.checkpoints[s.i] ?? null;
    if (s.k === 'start') return this.map.start;
    return this.map.spawns[s.i] ?? null;
  }

  reattach() {
    const it = this.selItem();
    if (!it) { this.gizmo.detach(); return; }
    this.pivot.position.set(...it.p);
    this.pivot.rotation.set(0, it.r ?? 0, 0);
    this.gizmo.attach(this.pivot);
    this.gizmo.showX = this.gizmo.showZ = this.gizmo.getMode() !== 'rotate';
  }

  livePivot() {
    // move the visual immediately; the data commits on drag end
    const it = this.selItem();
    if (!it) return;
    const dx = this.pivot.position.x - it.p[0], dy = this.pivot.position.y - it.p[1], dz = this.pivot.position.z - it.p[2];
    const s = this.sel!;
    const obj = s.k === 'obj' ? this.view.scene.children.find((c) => c.userData.obj === it) : s.k === 'cp' ? this.view.lines[s.i]?.group : s.k === 'start' ? this.view.lines[this.view.lines.length - 1]?.group : null;
    if (obj) {
      if (s.k === 'obj') { obj.position.set(it.p[0] + dx, obj.position.y + (dy - (obj.userData.dy ?? 0)), it.p[2] + dz); obj.userData.dy = dy; obj.rotation.y = this.pivot.rotation.y; }
      else obj.position.set(dx, dy, dz);
    }
  }

  commitPivot() {
    const it = this.selItem();
    if (!it) return;
    it.p = [r1(this.pivot.position.x), r1(this.pivot.position.y), r1(this.pivot.position.z)];
    if (it.r !== undefined) it.r = Math.round(this.pivot.rotation.y * 1000) / 1000;
    this.rebuild();
    this.renderRight();
  }

  pick(e: PointerEvent): { obj?: THREE.Object3D; point?: THREE.Vector3; sel?: Sel } {
    const rect = renderer.domElement.getBoundingClientRect();
    this.ray.setFromCamera(new THREE.Vector2(((e.clientX - rect.left) / rect.width) * 2 - 1, -((e.clientY - rect.top) / rect.height) * 2 + 1), camera);
    const hits = this.ray.intersectObjects(this.view.scene.children, true);
    for (const hit of hits) {
      let o: THREE.Object3D | null = hit.object;
      if (o === this.cursor || (o as any).isTransformControlsPlane) continue;
      let inGizmo = false;
      for (let p: THREE.Object3D | null = o; p; p = p.parent) if (p === this.gizmo.getHelper()) inGizmo = true;
      if (inGizmo) continue;
      while (o && !o.userData.obj && o.parent && o.parent !== this.view.scene) o = o.parent;
      if (o?.userData.obj) return { point: hit.point, sel: { k: 'obj', i: this.map.objects.indexOf(o.userData.obj) } };
      const li = this.view.lines.findIndex((l) => l.group === o || l.group === hit.object.parent);
      if (li >= 0) return { point: hit.point, sel: li === this.view.lines.length - 1 ? { k: 'start' } : { k: 'cp', i: li } };
      if (hit.object.type === 'Mesh' && (hit.object as THREE.Mesh).geometry.type === 'PlaneGeometry' && hit.object.parent === this.view.scene) return { point: hit.point };
      if ((hit.object as THREE.Mesh).geometry?.type === 'ConeGeometry' && !hit.object.userData.obj) {
        const i = this.map.spawns.findIndex((s) => Math.hypot(s.p[0] - hit.object.position.x, s.p[2] - hit.object.position.z) < 0.5);
        if (i >= 0) return { point: hit.point, sel: { k: 'spawn', i } };
      }
    }
    return {};
  }

  // ------------------------------------------------------------ input

  onDown = (e: PointerEvent) => {
    if (e.button !== 0 || (this.gizmo as any).dragging || (this.gizmo as any).axis) return;
    const hit = this.pick(e);
    const t = this.tool;
    if (t === 'select') {
      this.sel = hit.sel ?? null;
      this.reattach();
      this.renderRight();
      return;
    }
    if (!hit.point) return;
    const p = hit.point;
    if (['raise', 'lower', 'flatten', 'smooth'].includes(t)) {
      this.snapshot();
      this.painting = true;
      this.flattenTarget = heightAt(this.world.hf, p.x, p.z);
      this.paint(p);
      return;
    }
    this.snapshot();
    const camYaw = Math.atan2(camera.position.x - p.x, camera.position.z - p.z);
    const g = heightAt(this.world.hf, p.x, p.z);
    if (t === 'start') { this.map.start = { ...this.map.start, p: [r1(p.x), r1(g + this.map.start.h / 2 + 1), r1(p.z)], r: r3(camYaw + Math.PI) }; this.sel = { k: 'start' }; }
    else if (t === 'checkpoint') {
      if (this.map.checkpoints.length >= LIMITS.checkpoints) return toast('Checkpoint limit reached');
      const prev = this.map.checkpoints[this.map.checkpoints.length - 1] ?? this.map.start;
      const yaw = Math.atan2(-(p.x - prev.p[0]), -(p.z - prev.p[2]));
      this.map.checkpoints.push({ p: [r1(p.x), r1(g + 4.5), r1(p.z)], r: r3(yaw), w: 10, h: 7 });
      this.sel = { k: 'cp', i: this.map.checkpoints.length - 1 };
    } else if (t === 'spawn') { this.map.spawns.push({ p: [r1(p.x), r1(g + 3), r1(p.z)], r: r3(camYaw + Math.PI) }); this.sel = { k: 'spawn', i: this.map.spawns.length - 1 }; }
    else {
      if (this.map.objects.length >= LIMITS.objects) return toast('Object limit reached');
      const o: Obj = { t: t as ObjType, p: [r1(p.x), r1(g - (t === 'ring' ? -8 : 0.2)), r1(p.z)], s: defSize(t as ObjType), r: 0, c: defaultColor(t as ObjType) };
      if (t === 'ring') o.r = r3(camYaw);
      this.map.objects.push(o);
      this.sel = { k: 'obj', i: this.map.objects.length - 1 };
    }
    this.validRun = null;
    this.rebuild();
    this.renderRight();
  };
  flattenTarget = 0;

  onMove = (e: PointerEvent) => {
    if (!['raise', 'lower', 'flatten', 'smooth'].includes(this.tool)) { this.cursor.visible = false; return; }
    if (e.target !== renderer.domElement) return;
    const hit = this.pick(e);
    if (!hit.point) { this.cursor.visible = false; return; }
    this.cursor.visible = true;
    this.cursor.position.set(hit.point.x, hit.point.y + 0.5, hit.point.z);
    this.cursor.scale.setScalar(this.brush.r);
    if (this.painting && performance.now() - this.lastPaint > 90) this.paint(hit.point);
  };

  onUp = () => { if (this.painting) { this.painting = false; this.rebuild(); } };

  paint(p: THREE.Vector3) {
    this.lastPaint = performance.now();
    if (this.map.terrain.brushes.length >= LIMITS.brushes) { toast('Terrain brush limit reached — try larger strokes'); this.painting = false; return; }
    const t = this.tool;
    const amt = t === 'raise' ? this.brush.s : t === 'lower' ? -this.brush.s : t === 'flatten' ? r1(this.flattenTarget) : this.brush.s * 2;
    this.map.terrain.brushes.push([r1(p.x), r1(p.z), this.brush.r, amt, t === 'flatten' ? 1 : t === 'smooth' ? 2 : 0]);
    this.validRun = null;
    this.scheduleRebuild(250);
  }

  onKey = (e: KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === 'INPUT' || (e.target as HTMLElement).tagName === 'TEXTAREA' || app.session) return;
    if ((e.ctrlKey || e.metaKey) && e.key === 'z') { e.preventDefault(); e.shiftKey ? this.doRedo() : this.doUndo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'y') { e.preventDefault(); this.doRedo(); }
    else if ((e.ctrlKey || e.metaKey) && e.key === 'd') { e.preventDefault(); this.duplicate(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') this.remove();
    else if (e.key === 'g') this.gizmoMode('translate');
    else if (e.key === 'r') this.gizmoMode('rotate');
    else if (e.key === 'Escape') { this.sel = null; this.reattach(); this.renderRight(); this.setTool('select'); }
  };

  gizmoMode(m: 'translate' | 'rotate') { this.gizmo.setMode(m); this.reattach(); this.renderRight(); }

  remove() {
    const s = this.sel;
    if (!s || s.k === 'start') return;
    this.snapshot();
    if (s.k === 'obj') this.map.objects.splice(s.i, 1);
    if (s.k === 'cp') this.map.checkpoints.splice(s.i, 1);
    if (s.k === 'spawn') this.map.spawns.splice(s.i, 1);
    this.sel = null;
    this.validRun = null;
    this.rebuild();
    this.renderRight();
  }

  duplicate() {
    const s = this.sel;
    if (!s || s.k === 'start') return;
    this.snapshot();
    if (s.k === 'obj') { const o = structuredClone(this.map.objects[s.i]); o.p[0] += 6; this.map.objects.push(o); this.sel = { k: 'obj', i: this.map.objects.length - 1 }; }
    if (s.k === 'cp') { const c = structuredClone(this.map.checkpoints[s.i]); c.p[0] += 8; this.map.checkpoints.splice(s.i + 1, 0, c); this.sel = { k: 'cp', i: s.i + 1 }; }
    if (s.k === 'spawn') { const c = structuredClone(this.map.spawns[s.i]); c.p[0] += 4; this.map.spawns.push(c); }
    this.validRun = null;
    this.rebuild();
    this.renderRight();
  }

  loop = () => {
    if (!this.alive) return;
    this.raf = requestAnimationFrame(this.loop);
    this.orbit.update();
    this.view.update(performance.now() / 1000, camera.position);
    renderer.render(this.view.scene, camera);
  };

  // ------------------------------------------------------------ UI

  setTool(t: Tool) {
    this.tool = t;
    if (t !== 'select') { this.sel = null; this.gizmo.detach(); }
    this.cursor.visible = false;
    this.buildLeft();
    this.renderRight();
  }

  left!: HTMLElement;
  buildUi() {
    this.left = h('div.ed-left');
    this.right = h('div.ed-right');
    this.status = h('div.ed-status');
    const name = h('input', { type: 'text', value: this.map.name, maxLength: LIMITS.name, style: { width: '170px' }, onchange: (e: any) => { this.snapshot(); this.map.name = e.target.value; this.invalidate(); } });
    const top = h('div.ed-top', null,
      h('button.btn.sm', { onclick: () => this.exit() }, '← Exit'),
      name,
      h('label.row', null, 'Laps', h('input', { type: 'number', min: 1, max: 10, value: this.map.laps, style: { width: '52px' }, onchange: (e: any) => { this.snapshot(); this.map.laps = Math.max(1, Math.min(10, +e.target.value)); this.invalidate(); } })),
      h('button.btn.sm', { title: 'Undo (Ctrl+Z)', onclick: () => this.doUndo() }, '↶'),
      h('button.btn.sm', { title: 'Redo (Ctrl+Y)', onclick: () => this.doRedo() }, '↷'),
      h('div.grow'),
      h('button.btn.sm', { onclick: () => this.testFly() }, '▶ Test fly / validate'),
      h('button.btn.sm', { onclick: () => this.autoCheck() }, 'Auto-check'),
      h('button.btn.sm.primary', { onclick: () => this.publish() }, 'Publish'),
      h('button.btn.sm.ghost', { onclick: () => download(`${this.map.name.replace(/\W+/g, '_')}.dronemap.json`, this.map) }, 'Export'),
      h('button.btn.sm.ghost', { onclick: () => this.importMap() }, 'Import'),
      h('button.btn.sm.ghost', { onclick: () => { if (confirm('Start a new empty map? (current draft is replaced)')) { this.snapshot(); this.map = starterMap(); this.sel = null; this.rebuild(); this.renderRight(); } } }, 'New'),
    );
    this.root = h('div.screen.clear', null, top, this.left, this.right, this.status);
    go(() => this.root);
    this.buildLeft();
    this.renderRight();
  }

  buildLeft() {
    const T = (t: Tool, label: string) => h('button.btn.sm' + (this.tool === t ? '.on' : ''), { onclick: () => this.setTool(t) }, label);
    put(clear(this.left),
      h('h3', null, 'Tools'),
      T('select', '⬚ Select / move'),
      h('div.dim', { style: { fontSize: '11px', margin: '2px 0 8px' } }, 'G move · R rotate · Del delete · Ctrl+D duplicate · RMB orbit · MMB pan · wheel zoom'),
      h('h3', null, 'Course'),
      T('start', '🏁 Start / finish line'), T('checkpoint', '◻ Checkpoint (adds next)'), T('spawn', '▲ Free-roam spawn'),
      h('h3', null, 'Objects'),
      T('box', '■ Box / building'), T('cyl', '● Pillar'), T('tree', '🌲 Tree'), T('rock', '◆ Rock'), T('ring', '◯ Ring'), T('pad', '▭ Pad / platform'),
      h('h3', null, 'Terrain'),
      T('raise', '⬆ Raise'), T('lower', '⬇ Lower'), T('flatten', '▬ Flatten'), T('smooth', '≈ Smooth'),
      ['raise', 'lower', 'flatten', 'smooth'].includes(this.tool) ? h('div.col', { style: { marginTop: '6px' } },
        h('label.f', null, `Radius ${this.brush.r} m`, h('input', { type: 'range', min: 4, max: 80, value: this.brush.r, oninput: (e: any) => { this.brush.r = +e.target.value; this.buildLeft(); } })),
        h('label.f', null, `Strength ${this.brush.s}`, h('input', { type: 'range', min: 0.5, max: 12, step: 0.5, value: this.brush.s, oninput: (e: any) => { this.brush.s = +e.target.value; this.buildLeft(); } }))) : null,
    );
  }

  renderRight() {
    const R = clear(this.right);
    const it = this.selItem();
    const s = this.sel;
    const num = (label: string, get: () => number, set: (v: number) => void, step = 0.5) =>
      [h('span', null, label), h('input', { type: 'number', step, value: +get().toFixed(2), onchange: (e: any) => { this.snapshot(); set(+e.target.value); this.invalidate(); } })];
    if (s && it) {
      const title = s.k === 'obj' ? `${this.map.objects[s.i].t}` : s.k === 'cp' ? `Checkpoint ${s.i + 1} of ${this.map.checkpoints.length}` : s.k === 'start' ? 'Start / finish line' : 'Spawn point';
      put(R, h('div.row', null, h('h3', { style: { margin: 0, textTransform: 'capitalize' } }, title), h('div.grow'),
        h('button.btn.sm' + (this.gizmo.getMode() === 'translate' ? '.on' : ''), { onclick: () => this.gizmoMode('translate') }, 'Move'),
        h('button.btn.sm' + (this.gizmo.getMode() === 'rotate' ? '.on' : ''), { onclick: () => this.gizmoMode('rotate') }, 'Rotate')));
      const kv = h('div.kv', { style: { marginTop: '10px' } },
        ...num('X', () => it.p[0], (v) => (it.p[0] = v)), ...num('Y', () => it.p[1], (v) => (it.p[1] = v)), ...num('Z', () => it.p[2], (v) => (it.p[2] = v)),
        it.r !== undefined ? num('Yaw °', () => (it.r! * 180) / Math.PI, (v) => (it.r = r3((v * Math.PI) / 180)), 5) : null);
      R.append(kv);
      if (s.k === 'cp' || s.k === 'start') {
        const l = it as Line;
        R.append(h('div.kv', { style: { marginTop: '6px' } }, ...num('Width', () => l.w, (v) => (l.w = v)), ...num('Height', () => l.h, (v) => (l.h = v))));
        R.append(h('div.dim', { style: { fontSize: '12px', margin: '6px 0' } }, 'Fly through the opening in the direction of the glow (front). Rotate 180° to flip.'));
        if (s.k === 'cp') R.append(h('div.row', null,
          h('button.btn.sm', { disabled: s.i === 0, onclick: () => this.reorder(s.i, -1) }, '↑ Earlier'),
          h('button.btn.sm', { disabled: s.i === this.map.checkpoints.length - 1, onclick: () => this.reorder(s.i, 1) }, '↓ Later'),
          h('button.btn.sm', { onclick: () => { this.snapshot(); l.r = r3(l.r + Math.PI); this.invalidate(); } }, 'Flip')));
        else R.append(h('button.btn.sm', { onclick: () => { this.snapshot(); l.r = r3(l.r + Math.PI); this.invalidate(); } }, 'Flip direction'));
      }
      if (s.k === 'obj') {
        const o = this.map.objects[s.i];
        const sizeLabels = o.t === 'box' || o.t === 'pad' ? ['Width', 'Height', 'Depth'] : o.t === 'ring' ? ['Diameter', '', 'Thickness'] : o.t === 'rock' ? ['Size', '', ''] : ['Diameter', 'Height', ''];
        R.append(h('div.kv', { style: { marginTop: '6px' } }, ...sizeLabels.flatMap((lab, i) => (lab ? num(lab, () => o.s[i], (v) => (o.s[i] = v)) : [])),
          h('span', null, 'Color'), h('input', { type: 'color', value: o.c, onchange: (e: any) => { this.snapshot(); o.c = e.target.value; this.invalidate(); } })));
        R.append(h('h3', { style: { marginTop: '12px' } }, 'Texture'), this.texturePicker(o.tx, (k) => { this.snapshot(); if (k) o.tx = k; else delete o.tx; this.invalidate(); }));
      }
      R.append(h('div.row', { style: { marginTop: '12px' } },
        s.k !== 'start' ? h('button.btn.sm', { onclick: () => this.duplicate() }, 'Duplicate') : null,
        s.k !== 'start' ? h('button.btn.sm.danger', { onclick: () => this.remove() }, 'Delete') : null) as HTMLElement);
      R.append(h('hr', { style: { borderColor: 'var(--line)', margin: '16px 0' } }));
    }
    // map settings
    const m = this.map;
    const T = m.terrain;
    put(R,
      h('h3', null, 'Map'),
      h('div.kv', null,
        h('span', null, 'Sky'), h('select', { onchange: (e: any) => { this.snapshot(); m.sky = e.target.value; this.invalidate(); } }, ...['day', 'dusk', 'night', 'overcast'].map((v) => h('option', { selected: m.sky === v }, v))),
        ...num('Size ±m', () => m.size, (v) => (m.size = v), 10),
        h('span', null, 'Water'), h('input', { type: 'number', step: 0.5, placeholder: 'none', value: m.water ?? '', onchange: (e: any) => { this.snapshot(); m.water = e.target.value === '' ? null : +e.target.value; this.invalidate(); } }),
      ),
      h('textarea', { rows: 2, maxLength: LIMITS.desc, placeholder: 'Description', style: { width: '100%', marginTop: '6px' }, value: m.desc, onchange: (e: any) => { m.desc = e.target.value; this.invalidate(); } }),
      h('h3', { style: { marginTop: '12px' } }, 'Ground texture'),
      this.texturePicker(m.ground, (k) => { this.snapshot(); if (k) m.ground = k; else delete m.ground; this.invalidate(); }),
      h('h3', { style: { marginTop: '12px' } }, 'Terrain generator'),
      h('div.kv', null,
        ...num('Seed', () => T.seed, (v) => (T.seed = Math.floor(v)), 1),
        ...num('Height', () => T.amp, (v) => (T.amp = v), 1),
        ...num('Scale', () => T.scale, (v) => (T.scale = v), 5),
        ...num('Detail', () => T.octaves, (v) => (T.octaves = Math.floor(v)), 1),
        ...num('Base', () => T.base, (v) => (T.base = v), 1)),
      h('div.row', { style: { marginTop: '6px' } },
        h('button.btn.sm', { onclick: () => { this.snapshot(); T.seed = Math.floor(Math.random() * 1e6); this.invalidate(); } }, 'Random seed'),
        h('button.btn.sm', { onclick: () => { if (confirm('Remove all terrain brush strokes?')) { this.snapshot(); T.brushes = []; this.invalidate(); } } }, `Clear strokes (${T.brushes.length})`)),
      h('div.dim', { style: { fontSize: '12px', marginTop: '10px' } }, `${m.objects.length}/${LIMITS.objects} objects · ${m.checkpoints.length} checkpoints · ${T.brushes.length}/${LIMITS.brushes} strokes`),
    );
  }

  texturePicker(cur: string | undefined, set: (k: string | undefined) => void) {
    const sw = h('div.swatches', null,
      h('button', { title: 'None (color only)', class: !cur ? 'on' : '', style: { background: '#333' }, onclick: () => set(undefined) }, '∅'),
      ...this.textures.map((k) => h('button', { title: k, class: cur === k ? 'on' : '', style: { backgroundImage: `url(${swatch(k)})` }, onclick: () => set(k) })),
      h('button', { title: 'Upload your own', style: { background: '#222a3a' }, onclick: async () => { const k = await uploadTexture('map'); if (k) { this.textures.push(k); set(k); } } }, '+'),
    );
    return sw;
  }

  reorder(i: number, d: number) {
    this.snapshot();
    const c = this.map.checkpoints;
    [c[i], c[i + d]] = [c[i + d], c[i]];
    this.sel = { k: 'cp', i: i + d };
    this.invalidate();
  }

  invalidate() { this.validRun = null; this.rebuild(); this.renderRight(); }

  updateStatus() {
    if (!this.status) return;
    const hash = mapHash(sanitizeMap({ ...this.map, author: me.uid ? me.name ?? '' : '' }));
    const valid = this.validRun && this.validRun.mapHash === hash && this.validRun.laps === this.map.laps;
    this.status.innerHTML = valid
      ? `✔ Validated · author time <b>${fmtMs(this.validRun!.claimedMs)}</b> — ready to publish`
      : `Not validated — <b>Test fly</b> a full ${this.map.laps}-lap run to unlock publishing`;
    this.status.style.color = valid ? 'var(--good)' : '';
  }

  // ------------------------------------------------------------ actions

  suspend() {
    this.alive = false;
    cancelAnimationFrame(this.raf);
    this.gizmo.detach();
    this.orbit.enabled = false;
  }
  resume() {
    this.alive = true;
    this.orbit.enabled = true;
    camera.fov = 60; camera.updateProjectionMatrix();
    go(() => this.root);
    this.rebuild();
    this.raf = requestAnimationFrame(this.loop);
  }

  testFly() {
    if (this.map.checkpoints.length < 1) return toast('Add at least one checkpoint first');
    // the server stamps the author before hashing; match it so the validation run's map hash agrees
    this.map.author = me.name && me.uid ? me.name : '';
    this.map = sanitizeMap(this.map);
    const camPos = camera.position.clone(), tgt = this.orbit.target.clone();
    this.suspend();
    go(() => h('div.screen.clear'));
    app.session = new Session({
      kind: 'test', mapId: 'draft', map: this.map, meta: null, laps: this.map.laps,
      onExit: (res) => {
        app.session = null;
        if (res?.run) {
          this.validRun = res.run;
          toast(res.run.attempt ? `Validated: ${fmtMs(res.run.claimedMs)}` : `Run complete (${fmtMs(res.run.claimedMs)}) — sign in before test-flying to publish`);
        }
        camera.position.copy(camPos);
        this.orbit.target.copy(tgt);
        this.resume();
      },
    });
  }

  autoCheck() {
    if (this.map.checkpoints.length < 1) return toast('Add at least one checkpoint first');
    toast('Autopilot is flying your course…');
    setTimeout(() => {
      const map = sanitizeMap(this.map);
      const w = buildWorld(map);
      let stuck = -1;
      const inputs = autopilot(w, 1, 120 * 60 * 3, (e, sim) => { if (e.e === 'crash') stuck = sim.progress?.next ?? -1; });
      if (inputs) {
        const r = replayRun(buildWorld(map), { mode: 'arcade', rates: 1, laps: 1 }, inputs);
        toast(`✔ Autopilot finished a lap in ${fmtMs(r.totalMs)}. The course is completable.`, { ms: 7000 });
      } else {
        toast(`Autopilot could not finish${stuck >= 0 ? ` — it kept crashing around checkpoint ${stuck + 1}` : ''}. It flies straight lines, so tight or blocked sections can fail even if a human can make it.`, { err: true, ms: 9000 });
      }
    }, 30);
  }

  async publish() {
    if (!me.uid) { toast('Sign in to publish'); doSignIn(); return; }
    const map = sanitizeMap({ ...this.map, author: me.name });
    const hash = mapHash(map);
    if (!this.validRun || this.validRun.mapHash !== hash || this.validRun.laps !== map.laps) {
      modal('Validate first', h('div', null, 'Every published map needs a finished run by its author on the exact current version. Test-fly the full course (all laps); that run becomes the author time and the first leaderboard entry.'), [['OK', () => {}]]);
      return;
    }
    const thumb = mapThumb(map, 320, 200);
    try {
      const r = await api<{ id: string; authorMs: number }>('/maps', { body: { map, run: this.validRun, thumb } });
      toast(`Published! Author time ${fmtMs(r.authorMs)}`);
      try { localStorage.removeItem(DRAFT); } catch { /* ignore */ }
      this.exit(() => mapDetail(r.id, 'tt', this.back));
    } catch (e) {
      toast((e as Error).message, { err: true, ms: 8000 });
      if (/attest|live|again|submitted/.test((e as Error).message)) { this.validRun = null; this.updateStatus(); }
    }
  }

  async importMap() {
    const txt = await pickFile('.json');
    if (!txt) return;
    try { this.snapshot(); this.map = sanitizeMap(JSON.parse(txt)); this.sel = null; this.invalidate(); toast('Map imported'); }
    catch { toast('Not a map file', { err: true }); }
  }

  exit(to?: () => HTMLElement) {
    this.suspend();
    this.gizmo.dispose();
    this.orbit.dispose();
    this.view.dispose();
    renderer.domElement.removeEventListener('pointerdown', this.onDown);
    removeEventListener('pointermove', this.onMove);
    removeEventListener('pointerup', this.onUp);
    removeEventListener('keydown', this.onKey);
    go(to ?? this.back);
  }
}

const r1 = (x: number) => Math.round(x * 10) / 10;
const r3 = (x: number) => Math.round(x * 1000) / 1000;
function defSize(t: ObjType): V3 {
  switch (t) {
    case 'box': return [8, 8, 8];
    case 'cyl': return [3, 14, 3];
    case 'tree': return [6, 14, 0];
    case 'rock': return [5, 0, 0];
    case 'ring': return [10, 0, 2];
    case 'pad': return [12, 0.6, 12];
  }
}

function label(text: string, l: Line) {
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.fillStyle = '#ff7a1a'; g.beginPath(); g.arc(32, 32, 28, 0, 7); g.fill();
  g.fillStyle = '#111'; g.font = 'bold 32px sans-serif'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText(text, 32, 34);
  const sp = new THREE.Sprite(new THREE.SpriteMaterial({ map: new THREE.CanvasTexture(c), depthTest: false }));
  sp.position.set(l.p[0], l.p[1] + l.h / 2 + 3, l.p[2]);
  sp.scale.setScalar(3.2);
  sp.renderOrder = 5;
  return sp;
}
