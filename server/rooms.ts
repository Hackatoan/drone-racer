// Room types. The server relays drone states at NET_HZ, tracks race progress
// itself from those states, and is authoritative for PvP damage.
import type { Client, Hub } from './hub.ts';
import { recordHub } from './db.ts';
import { resolveMap, worldFor } from './maps.ts';
import type { C2S, CreateOpts, Phase, RoomInfo, RoomMode, S2C, SnapRow, RaceStanding, PvpScore, KoState } from '../shared/protocol.ts';
import { NET_HZ, COUNTDOWN_MS, RESULTS_MS, PVP_MATCH_MS, PVP_KILL_LIMIT, PVP_RESPAWN_MS, SPAWN_PROTECT_MS, MAX_HP, WEAPONS, KO_ROUND_LAPS, KO_ROUND_GRACE_MS } from '../shared/protocol.ts';
import type { MapData } from '../shared/map.ts';
import { gridSlot } from '../shared/map.ts';
import { type World, raycastWorld, raySphere } from '../shared/collide.ts';
import { Progress } from '../shared/course.ts';
import { MAX_SPEED, PILOT_R } from '../shared/physics.ts';
import { type V3, dist, norm, dot, lookDir, sub } from '../shared/math.ts';
import { generateArena } from '../shared/mapgen.ts';
import { spawnFor } from '../shared/replay.ts';

const finite = (a: unknown, n: number): a is number[] => Array.isArray(a) && a.length === n && a.every((x) => typeof x === 'number' && Number.isFinite(x));

export abstract class Room {
  players = new Map<string, Client>();
  phase: Phase = 'running';
  phaseAt = Date.now();
  lastSnap = 0;
  emptySince = 0;
  abstract readonly mode: RoomMode;

  constructor(public hub: Hub, public id: string, public opts: CreateOpts, public host: string, public map: MapData, public world: World, public mapName: string) {}

  info(): RoomInfo {
    return {
      id: this.id, mode: this.mode, mapId: this.opts.mapId, mapName: this.mapName, laps: this.opts.laps, collide: this.opts.collide,
      max: this.opts.max, priv: this.opts.priv, host: this.players.get(this.host)?.name ?? '', phase: this.phase,
      players: this.players.size, teamSize: this.opts.teamSize, seed: this.opts.mapId.startsWith('pvp:') ? Number(this.opts.mapId.slice(4)) : undefined,
    };
  }

  activity() {
    const names: Record<RoomMode, string> = { race: 'Racing', freeroam: 'Free roaming', pvp: 'In PvP', ko: 'Tournament knockout', tt: 'Time trial with friends' };
    return `${names[this.mode]} · ${this.mapName}`;
  }

  canJoin(_c: Client) { return true; }

  join(c: Client) {
    this.players.set(c.id, c);
    c.room = this;
    c.state = null;
    c.hist = [];
    c.ready = false;
    if (!this.players.has(this.host)) this.host = c.id;
    this.emptySince = 0;
    this.pushRoom();
  }

  leave(c: Client) {
    this.players.delete(c.id);
    if (c.room === this) c.room = null;
    if (this.host === c.id) this.host = this.players.keys().next().value ?? '';
    if (!this.players.size) this.emptySince = Date.now();
    this.pushRoom();
  }

  pushRoom() {
    const players = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, skin: p.skin, ready: p.ready, ping: p.ping, team: this.teamOf(p), guest: p.guest }));
    this.broadcast({ t: 'room', room: this.info(), players });
  }

  teamOf(_c: Client) { return 0; }

  broadcast(m: S2C, except?: Client) {
    const s = JSON.stringify(m);
    for (const p of this.players.values()) if (p !== except && p.ws.readyState === 1) p.ws.send(s);
  }

  setPhase(phase: Phase, extra: Partial<Extract<S2C, { t: 'phase' }>> = {}) {
    this.phase = phase;
    this.phaseAt = Date.now();
    this.broadcast({ t: 'phase', phase, at: this.phaseAt, ...extra });
    this.pushRoom();
  }

  /** Accept a drone state; returns the previous position for progress tracking. */
  onState(c: Client, m: Extract<C2S, { t: 's' }>): V3 | null {
    if (!finite(m.p, 3) || !finite(m.q, 4) || !finite(m.v, 3) || !Number.isFinite(m.yaw) || !Number.isFinite(m.pitch)) return null;
    const now = Date.now();
    const prev = c.state?.p ?? null;
    c.state = { p: m.p, q: m.q, v: m.v, yaw: m.yaw, pitch: m.pitch, at: now };
    c.hist.push({ at: now, p: m.p });
    while (c.hist.length && c.hist[0].at < now - 1000) c.hist.shift();
    return prev;
  }

  onMsg(c: Client, m: C2S) {
    if (m.t === 's') this.onState(c, m);
  }

  snapFlags(_c: Client) { return 0; }

  tick(now: number) {
    if (now - this.lastSnap >= 1000 / NET_HZ) {
      this.lastSnap = now;
      const ps: SnapRow[] = [];
      for (const p of this.players.values()) {
        const s = p.state;
        if (!s) continue;
        ps.push([p.id, r2(s.p[0]), r2(s.p[1]), r2(s.p[2]), r4(s.q[0]), r4(s.q[1]), r4(s.q[2]), r4(s.q[3]), r2(s.v[0]), r2(s.v[1]), r2(s.v[2]), this.snapFlags(p)]);
      }
      if (ps.length) this.broadcast({ t: 'snap', ts: now, ps });
    }
    if (!this.players.size && this.emptySince && now - this.emptySince > 15_000) this.hub.removeRoom(this);
  }

  /** A sanity-checked movement step: false for teleports or impossible speed. */
  plausible(c: Client, prev: V3 | null, now: V3, dtMs: number) {
    if (!prev) return false;
    return dist(prev, now) <= MAX_SPEED * Math.max(dtMs, 50) / 1000 * 1.6 + 3;
  }
}

const r2 = (x: number) => Math.round(x * 100) / 100;
const r4 = (x: number) => Math.round(x * 10000) / 10000;

// ===================================================================== free roam / shared time trial

class FreeRoom extends Room {
  readonly mode: RoomMode = 'freeroam';
}

class TtRoom extends Room {
  readonly mode: RoomMode = 'tt';
  best = new Map<string, { best: number | null; runs: number }>();
  onMsg(c: Client, m: C2S) {
    super.onMsg(c, m);
    if (m.t === 'tt' && m.e === 'finish' && Number.isFinite(m.ms) && m.ms > 0) {
      const b = this.best.get(c.id) ?? { best: null, runs: 0 };
      b.runs++;
      if (b.best === null || m.ms < b.best) b.best = Math.round(m.ms);
      this.best.set(c.id, b);
      this.pushStandings();
    }
  }
  join(c: Client) { super.join(c); this.pushStandings(); }
  leave(c: Client) { super.leave(c); this.best.delete(c.id); this.pushStandings(); }
  pushStandings() {
    const standings = [...this.players.values()].map((p) => ({ id: p.id, name: p.name, best: this.best.get(p.id)?.best ?? null, runs: this.best.get(p.id)?.runs ?? 0 }))
      .sort((a, b) => (a.best ?? 1e12) - (b.best ?? 1e12));
    this.broadcast({ t: 'tt', standings });
  }
}

// ===================================================================== races

interface Racer { prog: Progress; finishMs: number | null; lastAt: number; respawnOk: boolean; dnf: boolean }

class RaceRoom extends Room {
  readonly mode: RoomMode = 'race';
  phase: Phase = 'lobby';
  racers = new Map<string, Racer>();
  goAt = 0;
  firstFinishAt = 0;
  lastStandings = 0;

  laps() { return this.opts.laps; }

  onMsg(c: Client, m: C2S) {
    if (m.t === 's') {
      const prev = this.onState(c, m);
      const r = this.racers.get(c.id);
      if (!r || this.phase !== 'running' || r.finishMs !== null || !c.state) return;
      const now = c.state.at;
      if (r.respawnOk && prev) {
        // a respawn teleport must land at that racer's last line
        const rp = r.prog.respawnPoint(gridSlot(this.map, 0));
        r.respawnOk = false;
        if (dist(c.state.p, rp.p) < 8) { r.lastAt = now; return; }
      }
      if (prev && this.plausible(c, prev, c.state.p, now - r.lastAt)) {
        for (const e of r.prog.feed(prev, c.state.p, r.lastAt - this.goAt, now - this.goAt)) {
          if (e.e === 'finish') {
            r.finishMs = Math.round(e.totalMs + (r.prog.startT));
            if (!this.firstFinishAt) this.firstFinishAt = Date.now();
          }
        }
      }
      r.lastAt = now;
      this.pushStandings(false);
      return;
    }
    if (m.t === 'respawn') { const r = this.racers.get(c.id); if (r) r.respawnOk = true; return; }
    if (m.t === 'ready' && this.phase === 'lobby') { c.ready = !!m.v; this.pushRoom(); return; }
    if (m.t === 'settings' && c.id === this.host && this.phase === 'lobby' && this.mode === 'race') {
      if (m.opts.laps !== undefined) this.opts.laps = Math.max(1, Math.min(10, Math.floor(Number(m.opts.laps) || 1)));
      if (m.opts.collide !== undefined) this.opts.collide = !!m.opts.collide;
      this.pushRoom();
      return;
    }
    if (m.t === 'start' && c.id === this.host && this.phase === 'lobby' && this.mode === 'race') { this.startCountdown(); return; }
  }

  startCountdown() {
    this.racers.clear();
    const slots: Record<string, number> = {};
    [...this.players.values()].forEach((p, i) => {
      slots[p.id] = i;
      this.racers.set(p.id, { prog: new Progress(this.map, this.laps()), finishMs: null, lastAt: 0, respawnOk: false, dnf: false });
      p.state = null;
    });
    this.broadcast({ t: 'grid', slots });
    this.goAt = Date.now() + COUNTDOWN_MS;
    this.firstFinishAt = 0;
    this.setPhase('countdown', { endsAt: this.goAt });
  }

  standings(): RaceStanding[] {
    return [...this.racers.entries()].map(([id, r]) => ({
      id, name: this.players.get(id)?.name ?? '(left)', lap: r.prog.lap, cp: r.prog.next, finishMs: r.finishMs,
      bestLap: r.prog.lapTimes.length ? Math.round(Math.min(...r.prog.lapTimes)) : null,
    })).sort((a, b) =>
      (a.finishMs ?? 1e12) - (b.finishMs ?? 1e12) || b.lap - a.lap || b.cp - a.cp);
  }

  pushStandings(force: boolean) {
    const now = Date.now();
    if (!force && now - this.lastStandings < 250) return;
    this.lastStandings = now;
    this.broadcast({ t: 'race', standings: this.standings() });
  }

  join(c: Client) {
    super.join(c);
    if (this.phase !== 'lobby') {
      this.broadcast({ t: 'phase', phase: this.phase, at: this.phaseAt, endsAt: this.goAt });
      this.pushStandings(true);
    }
  }

  roundTimeoutMs() { return 15 * 60_000; }

  tick(now: number) {
    super.tick(now);
    if (this.phase === 'countdown' && now >= this.goAt) this.setPhase('running', { endsAt: this.goAt });
    if (this.phase === 'running') {
      const active = [...this.racers.entries()].filter(([id]) => this.players.has(id));
      const allDone = active.every(([, r]) => r.finishMs !== null);
      const grace = this.firstFinishAt && now - this.firstFinishAt > (this.mode === 'ko' ? KO_ROUND_GRACE_MS : 30_000);
      if (allDone || grace || now - this.goAt > this.roundTimeoutMs()) this.endRace();
    }
    if (this.phase === 'results' && now - this.phaseAt > RESULTS_MS) this.afterResults();
  }

  endRace() {
    this.pushStandings(true);
    this.setPhase('results');
    const st = this.standings().filter((s) => this.players.has(s.id));
    if (this.mode === 'race' && st.length >= 2) {
      st.forEach((s, i) => {
        const c = this.players.get(s.id);
        if (!c) return;
        const win = i === 0 && s.finishMs !== null;
        this.hub.addStats(c, { races: 1, ...(win ? { race_wins: 1 } : {}) });
        if (c.uid) recordHub(this.hub.db, c.name, win ? 'win' : 'loss');
      });
    }
  }

  afterResults() {
    for (const p of this.players.values()) p.ready = false;
    this.setPhase('lobby');
  }
}

// ===================================================================== tournament knockout

export class KoRoom extends RaceRoom {
  readonly mode: RoomMode = 'ko';
  ko: KoState;
  roster: Map<string, string>; // uid -> name
  done = false;
  onDone?: (winner: string | null, order: string[]) => void;
  round = 0;
  startedAt = Date.now();

  constructor(hub: Hub, id: string, opts: CreateOpts, map: MapData, world: World, mapName: string, public div: number, roster: Map<string, string>, public authorMs: number) {
    super(hub, id, opts, '', map, world, mapName);
    this.roster = roster;
    this.ko = { div, round: 0, alive: [...roster.values()], eliminated: [], lastRound: [], winner: null };
  }

  laps() { return KO_ROUND_LAPS; }
  canJoin(c: Client) { return !!c.uid && this.roster.has(c.uid); }
  roundTimeoutMs() { return Math.max(60_000, (this.authorMs / Math.max(1, this.map.laps)) * 3 + 30_000); }

  join(c: Client) {
    super.join(c);
    c.send({ t: 'ko', ko: this.ko });
  }

  tick(now: number) {
    // first round starts once the roster had a moment to load in
    if (!this.done && this.phase === 'lobby' && now - this.phaseAt > (this.round === 0 ? 20_000 : 3000)) this.startRound();
    super.tick(now);
  }

  startRound() {
    this.round++;
    this.ko.round = this.round;
    // only alive pilots race; the eliminated spectate
    this.racers.clear();
    const slots: Record<string, number> = {};
    let i = 0;
    for (const p of this.players.values()) {
      if (!p.uid || !this.ko.alive.includes(this.roster.get(p.uid)!)) continue;
      slots[p.id] = i++;
      this.racers.set(p.id, { prog: new Progress(this.map, KO_ROUND_LAPS), finishMs: null, lastAt: 0, respawnOk: false, dnf: false });
    }
    this.broadcast({ t: 'grid', slots });
    this.broadcast({ t: 'ko', ko: this.ko });
    this.goAt = Date.now() + COUNTDOWN_MS;
    this.firstFinishAt = 0;
    this.setPhase('countdown', { endsAt: this.goAt });
  }

  endRace() {
    super.endRace();
    const byName = new Map<string, number | null>();
    for (const name of this.ko.alive) byName.set(name, null);
    for (const [id, r] of this.racers) {
      const c = this.players.get(id);
      if (c?.uid && this.roster.has(c.uid)) byName.set(this.roster.get(c.uid)!, r.finishMs);
    }
    const results = [...byName.entries()].map(([name, ms]) => ({ name, ms })).sort((a, b) => (a.ms ?? 1e12) - (b.ms ?? 1e12));
    this.ko.lastRound = results;
    const finishers = results.filter((r) => r.ms !== null);
    let out: string[];
    if (!finishers.length) out = []; // nobody finished: replay the round
    else {
      const dnfs = results.filter((r) => r.ms === null).map((r) => r.name);
      const cut = this.ko.alive.length > 5 ? 2 : 1;
      out = dnfs.length ? dnfs : finishers.slice(-cut).map((r) => r.name);
      if (out.length >= this.ko.alive.length) out = out.slice(0, this.ko.alive.length - 1);
    }
    for (const n of out) this.ko.eliminated.push({ name: n, round: this.round });
    this.ko.alive = this.ko.alive.filter((n) => !out.includes(n));
    const stalled = !finishers.length && this.round >= 3 && results.every((r) => r.ms === null);
    if (this.ko.alive.length <= 1 || stalled || Date.now() - this.startedAt > 45 * 60_000) {
      this.ko.winner = this.ko.alive.length === 1 ? this.ko.alive[0] : null;
      this.done = true;
      const order = [...(this.ko.winner ? [this.ko.winner] : []), ...[...this.ko.eliminated].reverse().map((e) => e.name)];
      this.onDone?.(this.ko.winner, order);
    }
    this.broadcast({ t: 'ko', ko: this.ko });
  }

  afterResults() {
    if (this.done) { this.phase = 'results'; return; }
    this.setPhase('lobby');
  }
}

// ===================================================================== PvP

interface Fighter { hp: number; dead: boolean; respawnAt: number; protectUntil: number; lastFire: number[]; kills: number; deaths: number; team: number }

class PvpRoom extends Room {
  readonly mode: RoomMode = 'pvp';
  phase: Phase = 'lobby';
  f = new Map<string, Fighter>();
  endsAt = 0;
  teamKills: [number, number] = [0, 0];

  fighter(c: Client): Fighter {
    let f = this.f.get(c.id);
    if (!f) {
      f = { hp: MAX_HP, dead: false, respawnAt: 0, protectUntil: Date.now() + SPAWN_PROTECT_MS, lastFire: [0, 0], kills: 0, deaths: 0, team: this.pickTeam() };
      this.f.set(c.id, f);
    }
    return f;
  }

  pickTeam() {
    if (!this.opts.teamSize) return 0;
    let a = 0, b = 0;
    for (const f of this.f.values()) f.team === 1 ? a++ : b++;
    return a <= b ? 1 : 2;
  }

  teamOf(c: Client) { return this.f.get(c.id)?.team ?? 0; }

  join(c: Client) {
    this.fighter(c);
    super.join(c);
    this.spawn(c);
    if (this.phase !== 'lobby') this.broadcast({ t: 'phase', phase: this.phase, at: this.phaseAt, endsAt: this.endsAt, seed: this.info().seed });
    this.pushScores();
  }

  leave(c: Client) {
    super.leave(c);
    this.f.delete(c.id);
    this.pushScores();
  }

  spawn(c: Client) {
    const f = this.fighter(c);
    const sp = this.map.spawns;
    let pick = sp[0] ?? { p: spawnFor(this.map).p, r: 0 };
    if (f.team) {
      const half = sp.filter((_, i) => (f.team === 1 ? i < sp.length / 2 : i >= sp.length / 2));
      pick = half[Math.floor(Math.random() * half.length)] ?? pick;
    } else {
      // farthest from the nearest living enemy
      let best = -1;
      for (const s of sp) {
        let near = 1e9;
        for (const [id, o] of this.players) if (id !== c.id && o.state && !this.f.get(id)?.dead) near = Math.min(near, dist(o.state.p, s.p));
        if (near > best) { best = near; pick = s; }
      }
    }
    f.hp = MAX_HP;
    f.dead = false;
    f.protectUntil = Date.now() + SPAWN_PROTECT_MS;
    c.state = null;
    c.hist = [];
    this.broadcast({ t: 'spawn', id: c.id, p: pick.p, r: pick.r });
  }

  snapFlags(c: Client) {
    const f = this.f.get(c.id);
    if (!f) return 0;
    return (f.dead ? 1 : 0) | (Date.now() < f.protectUntil ? 2 : 0) | (f.team << 2);
  }

  /** Where was `c` at server time `at`? (lag compensation) */
  posAt(c: Client, at: number): V3 | null {
    const h = c.hist;
    if (!h.length) return c.state?.p ?? null;
    if (at >= h[h.length - 1].at) return h[h.length - 1].p;
    for (let i = h.length - 1; i > 0; i--) {
      if (h[i - 1].at <= at) {
        const a = h[i - 1], b = h[i];
        const t = (at - a.at) / Math.max(1, b.at - a.at);
        return [a.p[0] + (b.p[0] - a.p[0]) * t, a.p[1] + (b.p[1] - a.p[1]) * t, a.p[2] + (b.p[2] - a.p[2]) * t];
      }
    }
    return h[0].p;
  }

  onMsg(c: Client, m: C2S) {
    if (m.t === 's') {
      const f = this.f.get(c.id);
      if (f?.dead) return; // ignore movement while dead
      this.onState(c, m);
      return;
    }
    if (m.t === 'fire') this.fire(c, m);
  }

  fire(c: Client, m: Extract<C2S, { t: 'fire' }>) {
    const f = this.f.get(c.id);
    const w = WEAPONS[m.w];
    if (!f || !w || f.dead || !c.state || !finite(m.o, 3) || !finite(m.d, 3)) return;
    const now = Date.now();
    if (now - f.lastFire[m.w] < w.cooldownMs * 0.85) return;
    f.lastFire[m.w] = now;
    f.protectUntil = 0; // shooting ends spawn protection
    const d = norm(m.d as V3);
    if (dist(m.o as V3, c.state.p) > 6) return;
    if (dot(d, lookDir(c.state.yaw, c.state.pitch)) < 0.94) return; // guns are fixed forward
    const o = m.o as V3;
    const wallT = raycastWorld(this.world, o, d, w.range);
    let hitId: string | null = null;
    let hitT = Math.min(wallT, w.range);
    const rewindAt = now - Math.min(250, c.ping / 2 + 100);
    for (const [id, t] of this.players) {
      if (id === c.id) continue;
      const tf = this.f.get(id);
      if (!tf || tf.dead || (tf.team && tf.team === f.team)) continue;
      const p = this.posAt(t, rewindAt);
      if (!p) continue;
      const ht = raySphere(o, d, p, PILOT_R * 1.35);
      if (ht < hitT) { hitT = ht; hitId = id; }
    }
    const e: V3 = [o[0] + d[0] * hitT, o[1] + d[1] * hitT, o[2] + d[2] * hitT];
    this.broadcast({ t: 'shot', id: c.id, w: m.w, o, e, hit: hitId });
    if (!hitId || this.phase === 'results') return;
    const tf = this.f.get(hitId)!;
    if (now < tf.protectUntil) return;
    tf.hp -= w.dmg;
    this.broadcast({ t: 'dmg', id: hitId, hp: Math.max(0, tf.hp), by: c.id });
    if (tf.hp <= 0) {
      tf.dead = true;
      tf.respawnAt = now + PVP_RESPAWN_MS;
      const scoring = this.phase === 'running';
      if (scoring) {
        f.kills++;
        tf.deaths++;
        if (f.team) this.teamKills[f.team - 1]++;
        this.hub.addStats(c, { kills: 1 });
        const victim = this.players.get(hitId);
        if (victim) this.hub.addStats(victim, { deaths: 1 });
      }
      this.broadcast({ t: 'kill', killer: c.id, victim: hitId, w: m.w });
      this.pushScores();
      if (scoring && this.limitReached()) this.endMatch();
    }
  }

  killLimit() { return this.opts.teamSize ? this.opts.teamSize * 10 : PVP_KILL_LIMIT; }
  limitReached() {
    if (this.opts.teamSize) return this.teamKills.some((k) => k >= this.killLimit());
    return [...this.f.values()].some((x) => x.kills >= this.killLimit());
  }

  pushScores() {
    const scores: PvpScore[] = [...this.players.values()].map((p) => {
      const f = this.fighter(p);
      return { id: p.id, name: p.name, kills: f.kills, deaths: f.deaths, hp: f.hp, team: f.team };
    }).sort((a, b) => b.kills - a.kills || a.deaths - b.deaths);
    this.broadcast({ t: 'pvp', scores, endsAt: this.endsAt, teams: this.opts.teamSize ? this.teamKills : null });
  }

  needed() { return this.opts.teamSize ? 2 : 2; }

  tick(now: number) {
    super.tick(now);
    for (const [id, f] of this.f) {
      if (f.dead && now >= f.respawnAt) { const c = this.players.get(id); if (c) this.spawn(c); }
    }
    if (this.phase === 'lobby' && this.players.size >= this.needed()) {
      this.endsAt = now + COUNTDOWN_MS;
      this.setPhase('countdown', { endsAt: this.endsAt, seed: this.info().seed });
    } else if (this.phase === 'countdown' && now >= this.endsAt) {
      if (this.players.size < this.needed()) return this.setPhase('lobby');
      this.teamKills = [0, 0];
      for (const f of this.f.values()) { f.kills = 0; f.deaths = 0; }
      for (const c of this.players.values()) this.spawn(c);
      this.endsAt = now + PVP_MATCH_MS;
      this.setPhase('running', { endsAt: this.endsAt });
      this.pushScores();
    } else if (this.phase === 'running' && (now >= this.endsAt || this.players.size < 2)) {
      this.endMatch();
    } else if (this.phase === 'results' && now - this.phaseAt > RESULTS_MS) {
      this.nextArena();
    }
  }

  endMatch() {
    this.endsAt = Date.now() + RESULTS_MS;
    this.setPhase('results', { endsAt: this.endsAt });
    this.pushScores();
    const list = [...this.players.values()];
    if (list.length < 2) return;
    let winners: Client[];
    if (this.opts.teamSize) {
      const wt = this.teamKills[0] === this.teamKills[1] ? 0 : this.teamKills[0] > this.teamKills[1] ? 1 : 2;
      winners = list.filter((c) => wt && this.f.get(c.id)?.team === wt);
    } else {
      const top = Math.max(...list.map((c) => this.f.get(c.id)?.kills ?? 0));
      winners = top > 0 ? list.filter((c) => this.f.get(c.id)?.kills === top).slice(0, 1) : [];
    }
    for (const c of list) {
      const win = winners.includes(c);
      this.hub.addStats(c, { pvp_matches: 1, ...(win ? { pvp_wins: 1 } : {}) });
      if (c.uid) recordHub(this.hub.db, c.name, win ? 'win' : 'loss');
    }
  }

  nextArena() {
    const seed = Math.floor(Math.random() * 1e9);
    this.opts.mapId = `pvp:${seed}`;
    this.map = generateArena(seed);
    this.world = worldFor(this.opts.mapId, this.map);
    this.mapName = this.map.name;
    for (const f of this.f.values()) { f.kills = 0; f.deaths = 0; }
    this.teamKills = [0, 0];
    this.setPhase('lobby', { seed });
    for (const c of this.players.values()) this.spawn(c);
    this.pushScores();
  }
}

// ===================================================================== factory

export async function createRoom(hub: Hub, id: string, opts: CreateOpts, host: string): Promise<Room | null> {
  const m = await resolveMap(hub.db, opts.mapId);
  if (!m) return null;
  const world = worldFor(m.id, m.map);
  const name = m.map.name;
  switch (opts.mode) {
    case 'race': return new RaceRoom(hub, id, opts, host, m.map, world, name);
    case 'pvp': return new PvpRoom(hub, id, opts, host, m.map, world, name);
    case 'tt': return new TtRoom(hub, id, opts, host, m.map, world, name);
    default: return new FreeRoom(hub, id, opts, host, m.map, world, name);
  }
}
void sub;
