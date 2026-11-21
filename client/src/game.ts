// A play session: fixed-step deterministic sim + rendering + HUD + net.
import * as THREE from 'three';
import { h, clear, $, fmtMs, toast } from './dom.ts';
import { settings, me, localPb, saveLocalPb } from './state.ts';
import { Controls } from './input.ts';
import { net } from './net.ts';
import { api, medalFor, medals, type MapMeta } from './api.ts';
import { buildWorldView, type WorldView } from './scene.ts';
import { buildDrone, GHOST_COLORS, TEAM_COLORS, type DroneMesh } from './drone.ts';
import { initAudio, engine, sfx } from './audio.ts';
import { packInputs, loadReplay, download, type Replay } from './runfile.ts';
import type { MapData } from '../../shared/map.ts';
import { courseLines, gridSlot } from '../../shared/map.ts';
import { buildWorld, type World, raycastWorld } from '../../shared/collide.ts';
import { DT, BOOST_SPEED, pushApart, type FlightMode, PILOT_R } from '../../shared/physics.ts';
import { RunSim, quantize, quantYaw, quantPitch, emptyQ, type QInput, type RunFile, type SimEvent, TICK_HZ, TICK_MS, HB_EVERY_TICKS, hashStep, HASH_SEED, BTN_RESPAWN, mapHash } from '../../shared/replay.ts';
import { type V3, type Q4, lookDir, wrapAngle, clamp, qRotate } from '../../shared/math.ts';
import type { RoomInfo, PlayerInfo, RaceStanding, PvpScore, KoState, Phase } from '../../shared/protocol.ts';
import { WEAPONS, MAX_HP } from '../../shared/protocol.ts';

export type Kind = 'freeroam' | 'timetrial' | 'race' | 'pvp' | 'ko' | 'tt' | 'test' | 'replay';

export interface SessionOpts {
  kind: Kind;
  mapId: string;
  map: MapData;
  meta?: MapMeta | null;
  laps: number;
  room?: { info: RoomInfo; players: PlayerInfo[] };
  ghosts?: { run: RunFile; label: string; color: number }[];
  splitRef?: RunFile | null;
  replay?: RunFile;
  onExit: (result?: { run?: RunFile }) => void;
}

export let renderer: THREE.WebGLRenderer;
export let camera: THREE.PerspectiveCamera;

export function initRenderer() {
  // browsers only allow audio after a user gesture
  const unlock = () => { initAudio(); removeEventListener('pointerdown', unlock); removeEventListener('keydown', unlock); };
  addEventListener('pointerdown', unlock);
  addEventListener('keydown', unlock);
  renderer = new THREE.WebGLRenderer({ antialias: settings.quality !== 'low', powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(devicePixelRatio, settings.quality === 'high' ? 2 : 1));
  renderer.shadowMap.enabled = settings.quality !== 'low';
  renderer.shadowMap.type = THREE.PCFShadowMap;
  renderer.toneMapping = THREE.ACESFilmicToneMapping;
  renderer.outputColorSpace = THREE.SRGBColorSpace;
  $('#view').appendChild(renderer.domElement);
  camera = new THREE.PerspectiveCamera(settings.fov, innerWidth / innerHeight, 0.05, 2500);
  const resize = () => { renderer.setSize(innerWidth, innerHeight); camera.aspect = innerWidth / innerHeight; camera.updateProjectionMatrix(); };
  addEventListener('resize', resize);
  resize();
}

let controls: Controls;
export function getControls() {
  if (!controls) controls = new Controls(settings.input, renderer.domElement);
  controls.s = settings.input;
  return controls;
}

interface Remote {
  id: string;
  name: string;
  team: number;
  mesh: DroneMesh;
  snaps: { t: number; p: V3; q: Q4; v: V3; f: number }[];
  pos: V3;
  vel: V3;
  label: HTMLElement;
  flags: number;
}

const ord = (n: number) => `${n}${['th', 'st', 'nd', 'rd'][(n % 100 > 10 && n % 100 < 14) || n % 10 > 3 ? 0 : n % 10]}`;

export class Session {
  world: World;
  view: WorldView;
  sim!: RunSim;
  mode: FlightMode;
  drone: DroneMesh;
  ctl: Controls;
  yaw = 0;
  pitch = 0;
  acc = 0;
  last = performance.now();
  raf = 0;
  running = true;
  paused = false;
  frozen = false; // countdown / dead
  inputs: QInput[] = [];
  recording = false;
  prevP: V3 = [0, 0, 0];
  prevQ: Q4 = [0, 0, 0, 1];
  camMode: 'fpv' | 'chase';
  shake = 0;
  hud!: Record<string, HTMLElement>;
  hudTick = 0;
  splitIdx = 0;
  lastSplit: { d: number; at: number } | null = null;
  splitRows: string[] = [];
  refSplits: number[] = [];
  refTotal: number | null = null;
  ghosts: { r: Replay; mesh: DroneMesh; label: string; done: boolean }[] = [];
  replay: Replay | null = null;
  replaySpeed = 1;
  // online
  remotes = new Map<string, Remote>();
  offsets: number[] = [];
  lastSend = 0;
  phase: Phase = 'running';
  goAt = 0;
  standings: RaceStanding[] = [];
  scores: PvpScore[] = [];
  teams: [number, number] | null = null;
  pvpEnds = 0;
  ko: KoState | null = null;
  hp = MAX_HP;
  dead = false;
  fireCd = [0, 0];
  tracers: { line: THREE.Line; until: number }[] = [];
  feed: { m: string; until: number }[] = [];
  chatLines: { m: string; until: number }[] = [];
  hitMarkUntil = 0;
  unsub: (() => void)[] = [];
  // attestation
  attemptId: string | null = null;
  attemptNonce = 0;
  hash = HASH_SEED;
  finishedRun: RunFile | null = null;
  overlay: HTMLElement | null = null;
  ttBest: number | null = null;

  constructor(public o: SessionOpts) {
    this.ctl = getControls();
    this.mode = o.kind === 'pvp' ? 'arcade' : settings.flight;
    this.world = buildWorld(o.map);
    this.view = buildWorldView(o.map, this.world, settings.quality, renderer);
    this.camMode = settings.camera;
    this.drone = buildDrone(settings.skin, { guns: o.kind === 'pvp' });
    this.view.scene.add(this.drone.group);
    camera.fov = settings.fov;
    camera.updateProjectionMatrix();
    this.buildHud();
    this.resetSim(o.kind === 'replay' ? null : undefined);
    if (o.kind === 'replay' && o.replay) this.startReplay(o.replay);
    else this.loadGhosts();
    if (o.room) this.bindNet();
    if (o.kind === 'test' || o.kind === 'timetrial') this.toast(o.kind === 'test' ? 'Test flight — finish a full run to validate the map' : 'Cross the start line to begin');
    renderer.domElement.addEventListener('click', this.lockPointer);
    this.raf = requestAnimationFrame(this.frame);
    (window as any).__session = this;
  }

  lockPointer = () => {
    if (this.paused || !this.ctl.mouseLook || this.o.kind === 'replay') return;
    renderer.domElement.requestPointerLock?.()?.catch?.(() => {});
  };

  get course() { return ['timetrial', 'race', 'ko', 'tt', 'test', 'replay'].includes(this.o.kind); }
  get attested() { return ['timetrial', 'tt', 'test'].includes(this.o.kind); }
  get attestMapId() { return this.o.kind === 'test' ? `draft:${mapHash(this.o.map)}` : this.o.mapId; }

  resetSim(spawn?: { p: V3; r: number } | null) {
    const course = this.course && !(this.o.kind === 'ko' && this.ko && me.name && !this.ko.alive.includes(me.name));
    this.sim = new RunSim(this.world, { mode: this.mode, rates: settings.input.acroRates, laps: this.o.laps }, { course, spawn: spawn ?? undefined });
    this.yaw = this.sim.drone.yaw;
    this.pitch = 0;
    this.inputs = [];
    this.recording = this.attested;
    this.splitIdx = 0;
    this.splitRows = [];
    this.lastSplit = null;
    this.finishedRun = null;
    this.prevP = [...this.sim.drone.p] as V3;
    this.prevQ = [...this.sim.drone.q] as Q4;
    this.hash = HASH_SEED;
    for (const g of this.ghosts) { g.r.sim = new RunSim(this.world, g.r.sim.header); g.done = false; g.mesh.group.visible = true; }
    for (let i = 0; i < this.view.lines.length; i++) this.view.setLine(i, i === this.view.lines.length - 1 ? 'next' : 'later');
    if (this.attested) this.startAttempt();
  }

  startAttempt() {
    this.attemptId = null;
    if (!me.uid || !net.connected) return;
    const nonce = ++this.attemptNonce;
    const off = net.on('att', (m) => {
      if (m.nonce !== nonce) return;
      off();
      if (nonce === this.attemptNonce) this.attemptId = m.id;
    });
    net.send({ t: 'att', op: 'start', mapId: this.attestMapId, laps: this.o.laps, nonce });
  }

  async loadGhosts() {
    if (!this.o.ghosts?.length && !this.o.splitRef) return;
    for (const g of this.o.ghosts ?? []) {
      try {
        const r = await loadReplay(this.world, g.run);
        if (!this.running) return;
        const mesh = buildDrone(settings.skin, { ghost: g.color });
        this.view.scene.add(mesh.group);
        this.ghosts.push({ r, mesh, label: g.label, done: false });
        // ghosts run in lockstep with the player's tick
        while (r.sim.tick < this.sim.tick && !r.sim.finished) r.sim.step(r.inputs[r.sim.tick] ?? emptyQ());
      } catch { /* bad ghost — skip */ }
    }
    if (this.o.splitRef) {
      try {
        const r = await loadReplay(this.world, this.o.splitRef);
        this.refSplits = r.splits;
        this.refTotal = r.totalMs;
      } catch { /* ignore */ }
    }
  }

  async startReplay(run: RunFile) {
    try {
      this.replay = await loadReplay(this.world, run);
      this.sim = this.replay.sim;
      this.refSplits = [];
      this.camMode = 'chase';
    } catch (e) {
      toast(`Can't play this run: ${(e as Error).message}`, { err: true });
      this.exit();
    }
  }

  // ------------------------------------------------------------------ net

  bindNet() {
    const room = this.o.room!;
    this.phase = room.info.phase;
    for (const p of room.players) if (p.id !== net.id) this.addRemote(p);
    this.unsub.push(
      net.on('room', (m) => {
        const ids = new Set(m.players.map((p) => p.id));
        for (const [id, r] of this.remotes) if (!ids.has(id)) this.dropRemote(id, r);
        for (const p of m.players) if (p.id !== net.id && !this.remotes.has(p.id)) this.addRemote(p);
        for (const p of m.players) { const r = this.remotes.get(p.id); if (r) r.team = p.team; }
        this.o.room!.info = m.room;
        this.o.room!.players = m.players;
        if (this.o.kind === 'pvp' && m.room.mapId !== this.o.mapId) this.swapArena(m.room.mapId);
      }),
      net.on('snap', (m) => {
        const now = Date.now();
        const off = now - m.ts;
        this.offsets.push(off);
        if (this.offsets.length > 40) this.offsets.shift();
        for (const row of m.ps) {
          const [id, x, y, z, qx, qy, qz, qw, vx, vy, vz, f] = row;
          if (id === net.id) continue;
          const r = this.remotes.get(id);
          if (!r) continue;
          r.snaps.push({ t: m.ts, p: [x, y, z], q: [qx, qy, qz, qw], v: [vx, vy, vz], f });
          if (r.snaps.length > 30) r.snaps.shift();
        }
      }),
      net.on('phase', (m) => this.onPhase(m.phase, m.endsAt ?? 0)),
      net.on('grid', (m) => {
        const slot = m.slots[net.id];
        if (slot !== undefined) { this.resetSim(gridSlot(this.o.map, slot)); this.frozen = true; }
        else if (this.o.kind === 'ko') { this.resetSim(); this.frozen = false; }
      }),
      net.on('race', (m) => (this.standings = m.standings)),
      net.on('pvp', (m) => { this.scores = m.scores; this.teams = m.teams; this.pvpEnds = m.endsAt; const mine = m.scores.find((s) => s.id === net.id); if (mine) this.hp = mine.hp; }),
      net.on('ko', (m) => { this.ko = m.ko; }),
      net.on('tt', (m) => { this.ttStandings = m.standings; }),
      net.on('shot', (m) => {
        if (m.id !== net.id) { this.tracer(m.o, m.e, m.w); if (this.remotes.get(m.id)) sfx.shot(); }
        if (m.id === net.id && m.hit) { this.hitMarkUntil = performance.now() + 150; sfx.hit(); }
      }),
      net.on('dmg', (m) => { if (m.id === net.id) { this.hp = m.hp; this.shake = 0.5; sfx.hurt(); } }),
      net.on('kill', (m) => {
        const name = (id: string) => (id === net.id ? me.name ?? 'You' : this.remotes.get(id)?.name ?? '?');
        this.feed.push({ m: `${name(m.killer)} ${m.w ? '⚡' : '✦'} ${name(m.victim)}`, until: performance.now() + 5000 });
        if (m.victim === net.id) { this.dead = true; this.drone.group.visible = false; this.toast('Destroyed — respawning'); }
        if (m.killer === net.id) sfx.kill();
      }),
      net.on('spawn', (m) => {
        if (m.id !== net.id) { const r = this.remotes.get(m.id); if (r) r.snaps = []; return; }
        this.dead = false;
        this.hp = MAX_HP;
        this.drone.group.visible = true;
        this.resetSim({ p: m.p, r: m.r });
      }),
      net.on('chat', (m) => this.chatLines.push({ m: `${m.from}: ${m.m}`, until: performance.now() + 9000 })),
      net.on('left', () => this.exit()),
    );
    if (room.info.phase === 'countdown' || room.info.phase === 'running') this.onPhase(room.info.phase, 0);
  }

  ttStandings: { id: string; name: string; best: number | null; runs: number }[] = [];

  async swapArena(mapId: string) {
    const seed = Number(mapId.slice(4));
    const { generateArena } = await import('../../shared/mapgen.ts');
    const map = generateArena(seed);
    this.o.mapId = mapId;
    this.o.map = map;
    this.view.dispose();
    this.world = buildWorld(map);
    this.view = buildWorldView(map, this.world, settings.quality, renderer);
    this.view.scene.add(this.drone.group);
    for (const r of this.remotes.values()) this.view.scene.add(r.mesh.group);
    this.resetSim();
  }

  addRemote(p: PlayerInfo) {
    const ghostly = this.o.kind === 'tt' || (this.o.kind !== 'pvp' && !this.o.room?.info.collide);
    const mesh = buildDrone(p.skin, { guns: this.o.kind === 'pvp', teamColor: p.team ? TEAM_COLORS[p.team] : undefined, ...(ghostly ? { ghost: 0 } : {}) });
    if (ghostly) mesh.setOpacity(0.45);
    this.view.scene.add(mesh.group);
    const label = h('div.nameplate', null, p.name);
    if (p.team) label.style.color = `#${TEAM_COLORS[p.team].toString(16)}`;
    this.hud.names.appendChild(label);
    this.remotes.set(p.id, { id: p.id, name: p.name, team: p.team, mesh, snaps: [], pos: [0, -999, 0], vel: [0, 0, 0], label, flags: 0 });
  }

  dropRemote(id: string, r: Remote) {
    this.view.scene.remove(r.mesh.group);
    r.mesh.dispose();
    r.label.remove();
    this.remotes.delete(id);
  }

  onPhase(phase: Phase, endsAt: number) {
    this.phase = phase;
    if (this.o.kind === 'race' || this.o.kind === 'ko') {
      if (phase === 'countdown') { this.goAt = endsAt; this.frozen = true; this.lastBeep = -1; }
      if (phase === 'running') { this.frozen = false; this.goAt = 0; sfx.beep(true); }
      if (phase === 'lobby') { this.frozen = false; }
    }
    if (this.o.kind === 'pvp') {
      if (phase === 'countdown') { this.goAt = endsAt; this.lastBeep = -1; }
      if (phase === 'running') { this.goAt = 0; this.pvpEnds = endsAt; sfx.beep(true); }
    }
  }
  lastBeep = -1;

  remoteAt(r: Remote, renderT: number) {
    const s = r.snaps;
    if (!s.length) return null;
    if (renderT <= s[0].t) return s[0];
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].t <= renderT) {
        const a = s[i - 1], b = s[i];
        const t = clamp((renderT - a.t) / Math.max(1, b.t - a.t), 0, 1.5);
        const q = new THREE.Quaternion(...a.q).slerp(new THREE.Quaternion(...b.q), Math.min(1, t));
        return { p: [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t] as V3, q: [q.x, q.y, q.z, q.w] as Q4, v: b.v, f: b.f };
      }
    }
    return s[s.length - 1];
  }

  tracer(o: V3, e: V3, w: number) {
    const g = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(...o), new THREE.Vector3(...e)]);
    const line = new THREE.Line(g, new THREE.LineBasicMaterial({ color: w ? 0x29d3ff : 0xffb347, transparent: true, opacity: 0.9 }));
    this.view.scene.add(line);
    this.tracers.push({ line, until: performance.now() + (w ? 350 : 70) });
  }

  // ------------------------------------------------------------------ HUD

  buildHud() {
    const root = clear($('#hud'));
    const el = (k: string, sel: string, parent: HTMLElement = root, ...kids: any[]) => { const e = h(sel, null, ...kids); parent.appendChild(e); this.hud[k] = e; return e; };
    this.hud = {};
    el('speedlines', 'div.speedlines');
    el('names', 'div');
    const tl = el('tl', 'div.hud-tl');
    el('timer', 'div.timer', tl, '0.000');
    el('lap', 'div.lapline', tl);
    el('splits', 'div.splits', tl);
    const tr = el('tr', 'div.hud-tr');
    el('pos', 'div.pos', tr);
    el('board', 'div.board', tr);
    const tc = el('tc', 'div.hud-tc');
    el('split', 'div.split', tc);
    el('banner', 'div', tc);
    el('center', 'div.hud-c');
    const bl = el('bl', 'div.hud-bl');
    el('hp', 'div', bl);
    el('feed', 'div.killfeed', bl);
    el('chat', 'div.chat');
    const br = el('br', 'div.hud-br');
    el('speed', 'div.speed', br);
    el('boost', 'div.bar', br, h('i'));
    el('hint', 'div.hint', br);
    el('marker', 'div.cpmark');
    el('arrow', 'div.arrow');
    if (this.o.kind === 'pvp') el('cross', 'div.crosshair');
    el('fps', 'div.hint', root);
    this.hud.fps.style.cssText = 'position:absolute;left:50%;bottom:4px;transform:translateX(-50%)';
    this.hud.split.style.visibility = 'hidden';
  }

  toast(m: string) {
    this.hud.banner.className = 'banner';
    this.hud.banner.textContent = m;
    this.bannerUntil = performance.now() + 2500;
  }
  bannerUntil = 0;

  updateHud(now: number) {
    const H = this.hud;
    const d = this.sim.drone;
    const sp = Math.hypot(...d.v);
    H.speed.innerHTML = `${Math.round(sp * 3.6)}<small> km/h</small>`;
    (H.boost.firstChild as HTMLElement).style.width = `${d.boost * 100}%`;
    H.speedlines.style.opacity = String(clamp((sp - 35) / 30, 0, 1));
    if (now > this.bannerUntil && H.banner.textContent) { H.banner.textContent = ''; H.banner.className = ''; }
    const p = this.sim.progress;
    const k = this.o.kind;
    // timer
    if (p) {
      const t = p.finished ? p.totalMs : p.started ? this.sim.timeMs - p.startT : 0;
      H.timer.textContent = fmtMs(t);
      const lines = courseLines(this.o.map).length;
      H.lap.textContent = p.started ? `Lap ${Math.min(p.lap, this.o.laps)}/${this.o.laps} · CP ${p.next}/${lines - 1}` : k === 'race' || k === 'ko' ? '' : 'Cross the start line';
    } else {
      H.timer.textContent = k === 'pvp' ? (this.pvpEnds && this.phase === 'running' ? fmtMs(Math.max(0, this.pvpEnds - Date.now())).replace(/\.\d+$/, '') : '') : '';
      H.lap.textContent = k === 'freeroam' ? 'Free roam' : '';
    }
    H.splits.innerHTML = this.splitRows.slice(-6).join('');
    H.splits.style.display = this.splitRows.length ? '' : 'none';
    if (this.lastSplit && now - this.lastSplit.at < 2500) {
      H.split.style.visibility = 'visible';
      H.split.textContent = fmtMs(this.lastSplit.d, true);
      H.split.className = `split ${this.lastSplit.d <= 0 ? 'ahead' : 'behind'}`;
    } else H.split.style.visibility = 'hidden';
    // right side: position / boards
    let board = '';
    if ((k === 'race' || k === 'ko') && this.standings.length) {
      const idx = this.standings.findIndex((s) => s.id === net.id);
      H.pos.innerHTML = idx >= 0 ? `${ord(idx + 1)}<small>/${this.standings.length}</small>` : '';
      board = this.standings.slice(0, 8).map((s, i) => `<div class="${s.id === net.id ? 'me' : ''}"><span>${i + 1}. ${escape(s.name)}</span><span>${s.finishMs !== null ? fmtMs(s.finishMs) : `L${s.lap} CP${s.cp}`}</span></div>`).join('');
      if (this.ko) board = `<div><b>Division ${this.ko.div} · Round ${this.ko.round}</b><span>${this.ko.alive.length} left</span></div>` + board;
    } else if (k === 'pvp') {
      H.pos.innerHTML = this.teams ? `<span style="color:#ff4d5e">${this.teams[0]}</span> : <span style="color:#3d8bff">${this.teams[1]}</span>` : '';
      board = this.scores.slice(0, 8).map((s) => `<div class="${s.id === net.id ? 'me' : ''}" style="${s.team ? `color:#${TEAM_COLORS[s.team].toString(16)}` : ''}"><span>${escape(s.name)}</span><span>${s.kills}/${s.deaths}</span></div>`).join('');
    } else if (k === 'tt' && this.ttStandings.length) {
      H.pos.textContent = '';
      board = this.ttStandings.map((s) => `<div class="${s.id === net.id ? 'me' : ''}"><span>${escape(s.name)}</span><span>${fmtMs(s.best)}</span></div>`).join('');
    } else if (this.ghosts.length || this.refTotal) {
      H.pos.textContent = '';
      board = this.ghosts.map((g) => `<div><span>${escape(g.label)}</span><span>${fmtMs(g.r.totalMs)}</span></div>`).join('');
      if (this.o.meta?.authorMs) board += `<div class="dim"><span>Author</span><span>${fmtMs(this.o.meta.authorMs)}</span></div>`;
    } else H.pos.textContent = '';
    H.board.innerHTML = board;
    H.board.style.display = board ? '' : 'none';
    // PvP HP
    if (k === 'pvp') {
      H.hp.innerHTML = `<div class="speed">${Math.max(0, this.hp)}<small> HP</small></div><div class="bar hp"><i style="width:${Math.max(0, this.hp)}%"></i></div>`;
      H.cross.className = `crosshair${now < this.hitMarkUntil ? ' hit' : ''}`;
    }
    this.feed = this.feed.filter((f) => f.until > now);
    H.feed.innerHTML = this.feed.map((f) => `<div>${escape(f.m)}</div>`).join('');
    this.chatLines = this.chatLines.filter((f) => f.until > now).slice(-6);
    H.chat.innerHTML = this.chatLines.map((f) => `<div>${escape(f.m)}</div>`).join('');
    // countdown
    if (this.goAt && Date.now() < this.goAt) {
      const s = Math.ceil((this.goAt - Date.now()) / 1000);
      H.center.innerHTML = `<div class="countdown">${s}</div>`;
      if (s !== this.lastBeep) { this.lastBeep = s; sfx.beep(false); }
    } else if (this.phase === 'results' && (k === 'race' || k === 'ko' || k === 'pvp')) {
      H.center.innerHTML = `<div class="banner">${k === 'pvp' ? 'Match over' : 'Results'}</div>`;
    } else if (k === 'pvp' && this.phase === 'lobby') {
      H.center.innerHTML = '<div class="banner" style="font-size:18px">Waiting for another pilot… fly around</div>';
    } else if (k === 'race' && this.phase === 'lobby') {
      H.center.innerHTML = '';
    } else if (this.sim.crashTimer > 0) H.center.innerHTML = '<div class="banner" style="color:#ff4d5e">CRASHED</div>';
    else if (this.dead) H.center.innerHTML = '<div class="banner" style="color:#ff4d5e">DESTROYED</div>';
    else H.center.innerHTML = '';
    H.hint.innerHTML = this.o.kind === 'replay' ? `Replay ${this.replaySpeed}× · <span class="kbd">Space</span> pause · <span class="kbd">←/→</span> speed · <span class="kbd">V</span> camera · <span class="kbd">Esc</span> exit`
      : `<span class="kbd">V</span> camera · <span class="kbd">R</span> respawn${this.attested ? ' · <span class="kbd">⌫</span> restart' : ''} · <span class="kbd">Esc</span> menu`;
    H.fps.textContent = settings.showFps ? `${this.fps} fps · ${net.connected && this.o.room ? `${net.ping} ms` : ''}` : '';
  }
  fps = 0;
  fpsN = 0;
  fpsT = 0;

  /** Next-checkpoint marker/arrow. */
  updateMarker() {
    const p = this.sim.progress;
    const H = this.hud;
    if (!p || p.finished) { H.marker.style.display = H.arrow.style.display = 'none'; return; }
    const target = p.started ? p.lines[p.next] : this.o.map.start;
    const v = new THREE.Vector3(...target.p);
    const dist = v.distanceTo(new THREE.Vector3(...this.sim.drone.p));
    const ndc = v.clone().project(camera);
    const behind = ndc.z > 1;
    if (!behind && Math.abs(ndc.x) < 0.95 && Math.abs(ndc.y) < 0.95) {
      H.arrow.style.display = 'none';
      H.marker.style.display = '';
      H.marker.style.left = `${(ndc.x + 1) / 2 * innerWidth}px`;
      H.marker.style.top = `${(1 - ndc.y) / 2 * innerHeight - 22}px`;
      H.marker.textContent = `${p.started && p.next === p.lines.length - 1 ? (p.lap === this.o.laps ? 'FINISH' : 'LAP') : 'CP'} · ${Math.round(dist)} m`;
    } else {
      H.marker.style.display = 'none';
      H.arrow.style.display = '';
      let x = ndc.x, y = ndc.y;
      if (behind) { x = -x; y = -y; }
      const a = Math.atan2(x, y);
      const r = Math.min(innerWidth, innerHeight) * 0.38;
      H.arrow.style.left = `${innerWidth / 2 + Math.sin(a) * r - 12}px`;
      H.arrow.style.top = `${innerHeight / 2 - Math.cos(a) * r - 11}px`;
      H.arrow.style.transform = `rotate(${a}rad)`;
    }
  }

  // ------------------------------------------------------------------ main loop

  frame = (now: number) => {
    if (!this.running) return;
    this.raf = requestAnimationFrame(this.frame);
    const dt = Math.min(0.1, (now - this.last) / 1000);
    this.last = now;
    this.fpsN++;
    if (now - this.fpsT > 1000) { this.fps = this.fpsN; this.fpsN = 0; this.fpsT = now; }
    const c = this.ctl.poll(dt, this.mode);
    this.handleButtons();
    if (this.o.kind === 'replay') this.stepReplay(dt);
    else this.stepLive(dt, c);
    this.render(dt, now);
  };

  handleButtons() {
    const c = this.ctl;
    if (c.pressed('pause')) this.togglePause();
    if (c.pressed('camera')) { this.camMode = this.camMode === 'fpv' ? 'chase' : 'fpv'; settings.camera = this.camMode; }
    if (this.paused) return;
    if (c.pressed('restart') && this.attested) { this.resetSim(); this.toast('Restarted'); }
    if (c.pressed('chat') && this.o.room) this.openChat();
    if (c.pressed('scores')) this.toggleScores();
  }

  stepLive(dt: number, c: ReturnType<Controls['poll']>) {
    if (this.paused && !this.o.room) return;
    const live = !this.paused && !this.frozen && !this.dead;
    if (live && this.mode === 'arcade') {
      this.yaw = wrapAngle(this.yaw + c.dyaw);
      this.pitch = clamp(this.pitch + c.dpitch, -1.45, 1.45);
    }
    c.inp.yaw = this.yaw;
    c.inp.pitch = this.pitch;
    this.acc += dt;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.prevP = [...this.sim.drone.p] as V3;
      this.prevQ = [...this.sim.drone.q] as Q4;
      if (this.frozen || this.dead) {
        // countdown/dead: hold position, no input, no recording
        continue;
      }
      let q = live ? quantize(c.inp, c.buttons) : { ...emptyQ(), yaw: quantYaw(this.yaw), pitch: quantPitch(this.pitch) };
      // dev-only: e2e tests drive the drone with the autopilot (window.__bot = sim => QInput)
      const bot = import.meta.env.DEV ? (window as any).__bot : null;
      if (bot && live) { q = bot(this.sim); this.yaw = q.yaw * 1e-4; this.pitch = q.pitch * 1e-4; }
      // respawn is an edge: only on the first tick of this frame
      c.buttons &= ~BTN_RESPAWN;
      if (this.sim.finished) q = emptyQ();
      if (this.recording && !this.sim.finished) {
        this.inputs.push(q);
        this.hash = hashStep(this.hash, q);
      }
      const events = this.sim.step(q, this.o.room && this.o.room.info.collide && this.o.kind !== 'tt' ? (d) => this.collideRemotes(d) : undefined);
      if (this.mode === 'arcade' && (q.b & BTN_RESPAWN || events.some((e) => e.e === 'respawn'))) { this.yaw = this.sim.drone.yaw; this.pitch = 0; }
      this.onEvents(events);
      if (this.recording && this.attemptId && this.sim.tick % HB_EVERY_TICKS === 0 && !this.sim.finished)
        net.send({ t: 'att', op: 'hb', id: this.attemptId, tick: this.sim.tick, h: this.hash });
      for (const g of this.ghosts) {
        if (g.done) continue;
        g.r.sim.step(g.r.inputs[g.r.sim.tick] ?? emptyQ());
        if (g.r.sim.finished || g.r.sim.tick >= g.r.inputs.length) g.done = true;
      }
    }
    // firing (PvP)
    if (this.o.kind === 'pvp' && live) this.tryFire(c.fire, c.alt);
    // send state
    if (this.o.room && performance.now() - this.lastSend > 50 && !this.dead) {
      this.lastSend = performance.now();
      const d = this.sim.drone;
      net.send({ t: 's', p: d.p.map((x) => +x.toFixed(2)) as V3, q: d.q.map((x) => +x.toFixed(4)) as Q4, v: d.v.map((x) => +x.toFixed(2)) as V3, yaw: +d.yaw.toFixed(4), pitch: +d.pitch.toFixed(4) });
    }
  }

  collideRemotes(d: ReturnType<RunSim['drone']['valueOf']> & any) {
    for (const r of this.remotes.values()) {
      if (r.flags & 1) continue;
      if (pushApart(d, r.pos, r.vel)) { this.shake = 0.3; }
    }
  }

  tryFire(fire: boolean, alt: boolean) {
    const now = performance.now();
    for (const [w, want] of [[0, fire], [1, alt]] as [number, boolean][]) {
      if (!want || now < this.fireCd[w]) continue;
      const W = WEAPONS[w];
      this.fireCd[w] = now + W.cooldownMs;
      const d = this.sim.drone;
      let dir = lookDir(this.yaw, this.pitch);
      if (W.spread) dir = [dir[0] + (Math.random() - 0.5) * W.spread * 2, dir[1] + (Math.random() - 0.5) * W.spread * 2, dir[2] + (Math.random() - 0.5) * W.spread * 2];
      const n = Math.hypot(...dir);
      dir = [dir[0] / n, dir[1] / n, dir[2] / n];
      const o: V3 = [d.p[0] + dir[0] * 0.7, d.p[1] + dir[1] * 0.7 - 0.05, d.p[2] + dir[2] * 0.7];
      net.send({ t: 'fire', w, o, d: dir });
      const hit = raycastWorld(this.world, o, dir, W.range);
      const len = Math.min(hit, W.range);
      this.tracer(o, [o[0] + dir[0] * len, o[1] + dir[1] * len, o[2] + dir[2] * len], w);
      w ? sfx.rail() : sfx.shot();
      if (w) this.shake = Math.max(this.shake, 0.25);
    }
  }

  onEvents(events: SimEvent[]) {
    for (const e of events) {
      switch (e.e) {
        case 'start':
          if (this.o.kind !== 'race' && this.o.kind !== 'ko') this.toast('GO!');
          this.view.setLine(this.view.lines.length - 1, 'later');
          this.view.setLine(0, 'next');
          break;
        case 'checkpoint':
        case 'lap': {
          const p = this.sim.progress!;
          const tRun = e.t - p.startT;
          const ref = this.refSplits[this.splitIdx];
          const d = ref !== undefined ? tRun - ref : null;
          if (d !== null) this.lastSplit = { d, at: performance.now() };
          const label = e.e === 'lap' ? `Lap ${e.lap}` : `CP ${e.idx + 1}`;
          this.splitRows.push(`<div><span>${label}</span><span>${fmtMs(e.e === 'lap' ? e.lapMs : tRun)}</span>${d !== null ? `<span style="color:${d <= 0 ? 'var(--good)' : 'var(--bad)'}">${fmtMs(d, true)}</span>` : ''}</div>`);
          this.splitIdx++;
          e.e === 'lap' ? sfx.lap() : sfx.checkpoint(d === null ? null : d <= 0);
          const L = this.view.lines.length;
          const next = p.finished ? -1 : p.next;
          for (let i = 0; i < L; i++) this.view.setLine(i, i === next ? 'next' : i < next ? 'done' : 'later');
          if (e.e === 'lap' && !p.finished) this.toast(`Lap ${e.lap} · ${fmtMs(e.lapMs)}`);
          break;
        }
        case 'finish':
          sfx.finish();
          this.onFinish(e.totalMs);
          break;
        case 'crash':
          sfx.crash();
          this.shake = 1;
          break;
        case 'bump':
          sfx.bump();
          this.shake = Math.max(this.shake, Math.min(0.6, e.impact / 20));
          break;
        case 'respawn':
          if (this.o.room) net.send({ t: 'respawn' });
          break;
      }
    }
  }

  async onFinish(totalMs: number) {
    const k = this.o.kind;
    if (k === 'race' || k === 'ko') { this.toast(`Finished · ${fmtMs(totalMs)}`); return; }
    if (k === 'freeroam') return;
    this.recording = false;
    const run: RunFile = {
      kind: 'drone-run', v: 1, mapId: this.o.mapId, mapHash: mapHash(this.o.map), mapName: this.o.map.name, laps: this.o.laps,
      mode: this.mode, rates: settings.input.acroRates, player: me.name ?? 'Guest', ticks: this.inputs.length, claimedMs: Math.round(totalMs),
      lapTimes: this.sim.progress!.lapTimes.map(Math.round), date: new Date().toISOString(), data: await packInputs(this.inputs),
      skin: settings.skin, ...(this.attemptId ? { attempt: this.attemptId } : {}),
    };
    // final heartbeat right at the finish
    if (this.attemptId) net.send({ t: 'att', op: 'hb', id: this.attemptId, tick: this.inputs.length, h: this.hash });
    this.finishedRun = run;
    if (k === 'test') { this.showFinish(run, null); return; }
    const prev = localPb(this.o.mapId, this.o.laps, run.mapHash);
    const isPb = !prev || run.claimedMs < prev.claimedMs;
    if (isPb) saveLocalPb(run);
    if (k === 'tt') net.send({ t: 'tt', e: 'finish', ms: run.claimedMs });
    let server: any = null;
    if (me.uid && this.attemptId) {
      await new Promise((r) => setTimeout(r, 250)); // let the last heartbeat land first
      try { server = await api('/runs', { body: { run } }); } catch (e) { server = { error: (e as Error).message }; }
    }
    this.showFinish(run, server, isPb, prev?.claimedMs ?? null);
  }

  showFinish(run: RunFile, server: any, isPb = false, prevPb: number | null = null) {
    const k = this.o.kind;
    const ms = server?.ms ?? run.claimedMs;
    const author = this.o.meta?.authorMs;
    const medal = author ? medalFor(ms, author) : null;
    const body = h('div.col', null,
      h('div.timer', { style: { fontSize: '56px', fontFamily: 'var(--disp)' } }, fmtMs(ms)),
      h('div.dim', null, run.lapTimes.map((l, i) => `Lap ${i + 1}: ${fmtMs(l)}`).join(' · ')),
      medal ? h('div', null, h(`span.medal.m-${medal}`), `${medal[0].toUpperCase()}${medal.slice(1)} medal`) : author ? h('div.dim', null, `Bronze at ${fmtMs(medals(author).bronze)}`) : null,
      k === 'test' ? h('div', null, '✔ Map validated. Your time becomes the author time when you publish.') : null,
      isPb ? h('div', { style: { color: 'var(--good)' } }, prevPb ? `New personal best! (${fmtMs(ms - prevPb, true)})` : 'Personal best saved') : null,
      server?.ok ? h('div', { style: { color: 'var(--accent2)' } }, `Verified by replay · ${server.pb ? 'leaderboard updated' : 'not faster than your board time'} · rank #${server.rank}`) : null,
      server?.error ? h('div', { style: { color: 'var(--bad)' } }, `Not posted: ${server.error}`) : null,
      !me.uid && k !== 'test' ? h('div.dim', null, 'Sign in to post times to the leaderboard.') : null,
      me.uid && !this.attemptId && k !== 'test' ? h('div.dim', null, 'Not posted: run was not attested live (connection?).') : null,
    );
    const btns = h('div.row', { style: { marginTop: '14px' } },
      h('button.btn.primary', { onclick: () => { this.closeOverlay(); this.resetSim(); } }, 'Retry  ⌫'),
      k === 'test' ? h('button.btn.primary', { onclick: () => this.exit({ run }) }, 'Use this run & back to editor') : null,
      h('button.btn', { onclick: () => download(`${run.mapName.replace(/\W+/g, '_')}_${run.claimedMs}.dronerun`, run) }, 'Save run file'),
      h('button.btn', { onclick: () => { this.closeOverlay(); this.startReplay(run); this.o.kind = 'replay'; } }, 'Watch replay'),
      h('button.btn.ghost', { onclick: () => this.exit() }, 'Exit'),
    );
    this.showOverlay(h('div.panel', null, h('h2', null, k === 'test' ? 'Validation run complete' : 'Finished!'), body, btns));
  }

  stepReplay(dt: number) {
    const c = this.ctl;
    if (!this.replay) return;
    if (c.keys.has('Space') && !this.spaceHeld) { this.paused = !this.paused; }
    this.spaceHeld = c.keys.has('Space');
    if (c.keys.has('ArrowRight') && !this.arrowHeld) this.replaySpeed = Math.min(8, this.replaySpeed * 2);
    if (c.keys.has('ArrowLeft') && !this.arrowHeld) this.replaySpeed = Math.max(0.125, this.replaySpeed / 2);
    this.arrowHeld = c.keys.has('ArrowRight') || c.keys.has('ArrowLeft');
    if (this.paused) return;
    this.acc += dt * this.replaySpeed;
    while (this.acc >= DT) {
      this.acc -= DT;
      this.prevP = [...this.sim.drone.p] as V3;
      this.prevQ = [...this.sim.drone.q] as Q4;
      const q = this.replay.inputs[this.sim.tick];
      if (!q) { this.acc = 0; break; }
      const ev = this.sim.step(q);
      for (const e of ev) if (e.e === 'checkpoint' || e.e === 'lap') {
        const tRun = e.t - this.sim.progress!.startT;
        this.splitRows.push(`<div><span>${e.e === 'lap' ? `Lap ${e.lap}` : `CP ${e.idx + 1}`}</span><span>${fmtMs(e.e === 'lap' ? e.lapMs : tRun)}</span></div>`);
      }
      this.yaw = this.sim.drone.yaw;
      this.pitch = this.sim.drone.pitch;
    }
  }
  spaceHeld = false;
  arrowHeld = false;

  render(dt: number, now: number) {
    const d = this.sim.drone;
    const a = this.o.kind === 'replay' || !this.paused ? clamp(this.acc / DT, 0, 1) : 1;
    const p = new THREE.Vector3(this.prevP[0] + (d.p[0] - this.prevP[0]) * a, this.prevP[1] + (d.p[1] - this.prevP[1]) * a, this.prevP[2] + (d.p[2] - this.prevP[2]) * a);
    const q = new THREE.Quaternion(...this.prevQ).slerp(new THREE.Quaternion(...d.q), a);
    this.drone.group.position.copy(p);
    this.drone.group.quaternion.copy(q);
    const sp = Math.hypot(...d.v);
    const thr = this.mode === 'arcade' ? clamp(sp / BOOST_SPEED + 0.25, 0, 1) : clamp(this.inputs[this.inputs.length - 1]?.my ?? 0, 0, 127) / 127;
    this.drone.update(dt, thr);
    engine(thr, sp, !this.paused && this.running && !this.dead);

    // camera
    const fpv = this.camMode === 'fpv';
    this.drone.group.visible = !fpv && !this.dead;
    let camQ: THREE.Quaternion;
    if (this.mode === 'arcade') {
      const look = this.o.kind === 'replay' ? [d.yaw, d.pitch] : [this.yaw, this.pitch];
      camQ = new THREE.Quaternion().setFromEuler(new THREE.Euler(look[1], look[0], d.tilt[1] * 0.35, 'YXZ'));
    } else {
      camQ = q.clone().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(1, 0, 0), (settings.fpvTilt * Math.PI) / 180));
    }
    if (fpv) {
      const up = qRotate(d.q, [0, 0.08, -0.1]);
      camera.position.set(p.x + up[0], p.y + up[1], p.z + up[2]);
      camera.quaternion.copy(camQ);
    } else {
      const back = new THREE.Vector3(0, 0, 1).applyQuaternion(camQ);
      const want = p.clone().addScaledVector(back, 4.2).add(new THREE.Vector3(0, 1.3, 0));
      const dir = want.clone().sub(p);
      const len = dir.length();
      dir.normalize();
      const hit = raycastWorld(this.world, [p.x, p.y + 0.3, p.z], [dir.x, dir.y, dir.z], len);
      if (Number.isFinite(hit)) want.copy(p).addScaledVector(dir, Math.max(0.6, hit - 0.4));
      camera.position.lerp(want, 1 - Math.exp(-dt * 14));
      if (camera.position.distanceTo(want) > 30) camera.position.copy(want);
      camera.lookAt(p.clone().addScaledVector(new THREE.Vector3(0, 0, -1).applyQuaternion(camQ), 6).add(new THREE.Vector3(0, 0.4, 0)));
    }
    if (settings.shake && this.shake > 0.01) {
      const s = this.shake * 0.02;
      camera.rotation.x += (Math.random() - 0.5) * s;
      camera.rotation.y += (Math.random() - 0.5) * s;
      this.shake *= Math.exp(-dt * 6);
    }
    const fov = settings.fov + (settings.fovKick ? clamp((sp - 25) / (BOOST_SPEED - 25), 0, 1) * 14 : 0);
    if (Math.abs(camera.fov - fov) > 0.1) { camera.fov += (fov - camera.fov) * Math.min(1, dt * 6); camera.updateProjectionMatrix(); }

    // ghosts
    for (const g of this.ghosts) {
      g.mesh.group.visible = !g.done;
      g.mesh.group.position.set(...g.r.sim.drone.p);
      g.mesh.group.quaternion.set(...g.r.sim.drone.q);
      g.mesh.update(dt, 0.6);
    }
    // remotes
    if (this.remotes.size) {
      const off = this.offsets.length ? Math.min(...this.offsets) : 0;
      const renderT = Date.now() - off - 110;
      for (const r of this.remotes.values()) {
        const s = this.remoteAt(r, renderT);
        if (!s) { r.mesh.group.visible = false; r.label.style.display = 'none'; continue; }
        r.flags = s.f;
        r.pos = s.p; r.vel = s.v;
        const dead = (s.f & 1) !== 0;
        r.mesh.group.visible = !dead;
        r.mesh.group.position.set(...s.p);
        r.mesh.group.quaternion.set(...s.q);
        r.mesh.update(dt, 0.6);
        const v = new THREE.Vector3(s.p[0], s.p[1] + 0.7, s.p[2]).project(camera);
        const show = settings.nameplates && !dead && v.z < 1 && Math.abs(v.x) < 1.1 && Math.abs(v.y) < 1.1;
        r.label.style.display = show ? '' : 'none';
        if (show) { r.label.style.left = `${(v.x + 1) / 2 * innerWidth}px`; r.label.style.top = `${(1 - v.y) / 2 * innerHeight}px`; }
      }
    }
    for (const t of this.tracers) if (now > t.until) { this.view.scene.remove(t.line); t.line.geometry.dispose(); }
    this.tracers = this.tracers.filter((t) => now <= t.until);
    this.view.update(now / 1000, camera.position);
    renderer.render(this.view.scene, camera);
    if (now - this.hudTick > 33) { this.hudTick = now; this.updateHud(now); this.updateMarker(); }
  }

  // ------------------------------------------------------------------ overlays

  showOverlay(panel: HTMLElement) {
    this.closeOverlay();
    document.exitPointerLock?.();
    this.overlay = h('div.overlay', null, panel);
    $('#ui').appendChild(this.overlay);
  }
  closeOverlay() { this.overlay?.remove(); this.overlay = null; }

  togglePause() {
    if (this.finishedRun && this.overlay) return;
    if (this.paused || this.overlay) { this.paused = false; this.closeOverlay(); this.lockPointer(); return; }
    this.paused = true;
    const k = this.o.kind;
    const items = [
      h('button.btn.primary', { onclick: () => this.togglePause() }, 'Resume'),
      this.attested ? h('button.btn', { onclick: () => { this.togglePause(); this.resetSim(); } }, 'Restart run') : null,
      h('button.btn', { onclick: () => { this.camMode = this.camMode === 'fpv' ? 'chase' : 'fpv'; } }, 'Toggle camera'),
      this.o.room && me.uid ? h('button.btn', { onclick: () => openFriendsDrawer?.(true) }, 'Invite friends') : null,
      this.o.room ? h('div.dim', null, `Room code: `, h('b', null, this.o.room.info.id)) : null,
      h('button.btn.ghost', { onclick: () => this.exit() }, k === 'test' ? 'Back to editor' : this.o.room ? 'Leave room' : 'Exit to menu'),
    ];
    const s = h('div.col', null,
      h('label.f', null, `Mouse sensitivity ${settings.input.mouseSens.toFixed(1)}`, h('input', { type: 'range', min: 0.3, max: 8, step: 0.1, value: settings.input.mouseSens, oninput: (e: any) => { settings.input.mouseSens = +e.target.value; } })),
      h('label.f', null, `Field of view ${settings.fov}°`, h('input', { type: 'range', min: 60, max: 120, step: 1, value: settings.fov, oninput: (e: any) => { settings.fov = +e.target.value; } })),
    );
    this.showOverlay(h('div.panel', null, h('h2', null, this.o.room ? 'Menu (game continues)' : 'Paused'), h('div.col', null, ...items), h('hr', { style: { borderColor: 'var(--line)', margin: '16px 0' } }), s));
  }

  openChat() {
    document.exitPointerLock?.();
    const input = h('input', { type: 'text', maxLength: 200, placeholder: 'Say something…', style: { position: 'absolute', left: '18px', bottom: '90px', width: '320px' } }) as HTMLInputElement;
    $('#ui').appendChild(input);
    input.focus();
    const done = (send: boolean) => { if (send && input.value.trim()) net.send({ t: 'chat', m: input.value.trim() }); input.remove(); this.lockPointer(); };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') done(true); if (e.key === 'Escape') done(false); e.stopPropagation(); });
    input.addEventListener('blur', () => done(false));
  }

  scoresEl: HTMLElement | null = null;
  toggleScores() {
    if (this.scoresEl) { this.scoresEl.remove(); this.scoresEl = null; return; }
    const rows = this.o.kind === 'pvp'
      ? this.scores.map((s, i) => h('tr', { class: s.id === net.id ? 'me' : '' }, h('td', null, i + 1), h('td', null, s.name), h('td', null, s.team ? ['', 'Red', 'Blue'][s.team] : ''), h('td', null, s.kills), h('td', null, s.deaths)))
      : this.standings.map((s, i) => h('tr', { class: s.id === net.id ? 'me' : '' }, h('td', null, i + 1), h('td', null, s.name), h('td', null, `L${s.lap}`), h('td.mono', null, fmtMs(s.finishMs)), h('td.mono', null, fmtMs(s.bestLap))));
    const head = this.o.kind === 'pvp' ? ['#', 'Pilot', 'Team', 'K', 'D'] : ['#', 'Pilot', 'Lap', 'Finish', 'Best lap'];
    this.scoresEl = h('div.overlay', { style: { pointerEvents: 'none', background: 'transparent' } }, h('div.panel', null, h('table.t', null, h('tr', null, head.map((x) => h('th', null, x))), rows)));
    $('#ui').appendChild(this.scoresEl);
  }

  exit(result?: { run?: RunFile }) {
    if (!this.running) return;
    this.running = false;
    cancelAnimationFrame(this.raf);
    for (const u of this.unsub) u();
    if (this.o.room && !result) net.send({ t: 'leave' });
    document.exitPointerLock?.();
    renderer.domElement.removeEventListener('click', this.lockPointer);
    this.closeOverlay();
    this.scoresEl?.remove();
    engine(0, 0, false);
    this.view.dispose();
    this.drone.dispose();
    for (const g of this.ghosts) g.mesh.dispose();
    for (const r of this.remotes.values()) r.mesh.dispose();
    clear($('#hud'));
    renderer.clear();
    this.o.onExit(result);
  }
}

/** Set by the UI layer so the pause menu can open the friends drawer. */
export let openFriendsDrawer: ((invite: boolean) => void) | null = null;
export const setFriendsDrawer = (f: (invite: boolean) => void) => { openFriendsDrawer = f; };

const escape = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
void TICK_HZ; void TICK_MS; void PILOT_R; void GHOST_COLORS;
