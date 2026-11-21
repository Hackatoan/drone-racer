// Protocol-level multiplayer tests against a running dev server (AUTH_DEV=1).
//   npx tsx scripts/nettest.ts pvp|race|tourney [port]
import WebSocket from 'ws';
import { gzipSync } from 'node:zlib';
import { officialMap, autopilot } from '../shared/mapgen.ts';
import { buildWorld } from '../shared/collide.ts';
import { RunSim, encodeInputs, hashStep, HASH_SEED, HB_EVERY_TICKS, mapHash, type QInput } from '../shared/replay.ts';
import type { S2C } from '../shared/protocol.ts';

const [scenario = 'pvp', port = '3043'] = process.argv.slice(2);
const BASE = `http://localhost:${port}`;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };

async function pilot(uid: string, name: string) {
  await fetch(`${BASE}/api/me/name`, { method: 'POST', headers: { Authorization: `Bearer dev:${uid}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name }) });
}

class Bot {
  ws: WebSocket;
  msgs: S2C[] = [];
  id = '';
  constructor(public uid: string) {
    this.ws = new WebSocket(`ws://localhost:${port}/ws`);
    this.ws.on('message', (d) => { const m = JSON.parse(d.toString()); this.msgs.push(m); if (m.t === 'welcome') this.id = m.id; });
  }
  async open() { if (this.ws.readyState !== 1) await new Promise((r) => this.ws.once('open', r)); this.send({ t: 'hello', token: `dev:${this.uid}`, skin: null }); await this.wait('welcome'); }
  send(m: any) { this.ws.send(JSON.stringify(m)); }
  async wait<T extends S2C['t']>(t: T, pred: (m: Extract<S2C, { t: T }>) => boolean = () => true, ms = 15000): Promise<Extract<S2C, { t: T }>> {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      const i = this.msgs.findIndex((m) => m.t === t && pred(m as any));
      if (i >= 0) return this.msgs.splice(i, 1)[0] as any;
      await sleep(25);
    }
    throw new Error(`timeout waiting for ${t}`);
  }
  last<T extends S2C['t']>(t: T) { return [...this.msgs].reverse().find((m) => m.t === t) as Extract<S2C, { t: T }> | undefined; }
}

/** Fly a recorded autopilot trajectory in real time, streaming states (and optionally heartbeats). */
async function flyTrajectory(b: Bot, mapId: string, laps: number, opts: { attempt?: string; startTick?: number } = {}) {
  const map = officialMap(mapId.slice(2))!;
  const world = buildWorld(map);
  const inputs = autopilot(world, laps)!;
  const sim = new RunSim(world, { mode: 'arcade', rates: 1, laps });
  const t0 = Date.now();
  let h = HASH_SEED;
  for (let i = 0; i < inputs.length; i++) {
    sim.step(inputs[i]);
    h = hashStep(h, inputs[i]);
    if (opts.attempt && sim.tick % HB_EVERY_TICKS === 0) b.send({ t: 'att', op: 'hb', id: opts.attempt, tick: sim.tick, h });
    if (sim.tick % 6 === 0) {
      const d = sim.drone;
      b.send({ t: 's', p: d.p, q: d.q, v: d.v, yaw: d.yaw, pitch: d.pitch });
      const due = t0 + (sim.tick * 1000) / 120;
      const wait = due - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  const d = sim.drone; // final state so the server sees the finish-line crossing
  b.send({ t: 's', p: d.p, q: d.q, v: d.v, yaw: d.yaw, pitch: d.pitch });
  if (opts.attempt) b.send({ t: 'att', op: 'hb', id: opts.attempt, tick: inputs.length, h });
  return { inputs, ms: sim.progress!.totalMs, map };
}

async function submitRun(b: Bot, mapId: string, laps: number, inputs: QInput[], map: any, attempt: string) {
  await sleep(300);
  const run = { kind: 'drone-run', v: 1, mapId, mapHash: mapHash(map), mapName: map.name, laps, mode: 'arcade', rates: 1, player: b.uid, ticks: inputs.length, claimedMs: 0, lapTimes: [], date: '', data: gzipSync(encodeInputs(inputs)).toString('base64'), attempt };
  const r = await fetch(`${BASE}/api/runs`, { method: 'POST', headers: { Authorization: `Bearer dev:${b.uid}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ run }) });
  return r.json();
}

if (scenario === 'pvp') {
  await pilot('pvpA', 'PvpAlpha'); await pilot('pvpB', 'PvpBravo');
  const a = new Bot('pvpA'), b = new Bot('pvpB');
  await a.open(); await b.open();
  a.send({ t: 'create', opts: { mode: 'pvp', mapId: '', laps: 1, collide: true, priv: true, max: 8, teamSize: 0 } });
  const room = await a.wait('room');
  b.send({ t: 'join', id: room.room.id });
  await b.wait('room');
  await a.wait('phase', (m) => m.phase === 'running', 10000);
  check(true, 'pvp match started with 2 pilots');
  // hover high in the air facing each other along Z
  const P: [number, number, number] = [0, 150, 0];
  const send = () => {
    a.send({ t: 's', p: P, q: [0, 0, 0, 1], v: [0, 0, 0], yaw: 0, pitch: 0 }); // looks -Z
    b.send({ t: 's', p: [P[0], P[1], P[2] - 12], q: [0, 1, 0, 0], v: [0, 0, 0], yaw: Math.PI, pitch: 0 });
  };
  for (let i = 0; i < 6; i++) { send(); await sleep(60); }
  await sleep(2100); // spawn protection
  for (let i = 0; i < 16; i++) { send(); a.send({ t: 'fire', w: 0, o: [P[0], P[1], P[2] - 0.7], d: [0, 0, -1] }); await sleep(130); }
  const dmg = b.msgs.filter((m) => m.t === 'dmg' && (m as any).id === b.id).length + (b.last('kill') ? 1 : 0);
  const kill = a.msgs.find((m) => m.t === 'kill') as any;
  check(dmg > 0, `blaster hits registered server-side (${dmg} damage events)`);
  check(!!kill && kill.killer === a.id && kill.victim === b.id, 'kill credited to the shooter');
  const scores = a.last('pvp');
  check(!!scores && scores.scores.find((s) => s.id === a.id)!.kills === 1, 'scoreboard shows the kill');
  // shooting from far away from your real position is ignored
  a.msgs.length = 0;
  a.send({ t: 'fire', w: 1, o: [P[0], P[1], P[2] - 11], d: [0, 0, -1] });
  await sleep(300);
  check(!a.msgs.some((m) => m.t === 'shot'), 'shot with a spoofed muzzle position is dropped');
  a.ws.close(); b.ws.close();
}

if (scenario === 'race') {
  await pilot('raceA', 'RaceAlpha'); await pilot('raceB', 'RaceBravo');
  const a = new Bot('raceA'), b = new Bot('raceB');
  await a.open(); await b.open();
  a.send({ t: 'create', opts: { mode: 'race', mapId: 'o:meadow-loop', laps: 1, collide: false, priv: true, max: 8, teamSize: 0 } });
  const room = await a.wait('room');
  b.send({ t: 'join', id: room.room.id });
  await b.wait('room');
  a.send({ t: 'start' });
  const grid = await a.wait('grid');
  check(Object.keys(grid.slots).length === 2, 'grid assigned for both racers');
  await a.wait('phase', (m) => m.phase === 'running', 8000);
  // B "teleports" across the map: must not get progress
  b.send({ t: 's', p: [0, 10, 0], q: [0, 0, 0, 1], v: [0, 0, 0], yaw: 0, pitch: 0 });
  const r = await flyTrajectory(a, 'o:meadow-loop', 1);
  const res = await a.wait('phase', (m) => m.phase === 'results', 60000); // 30 s grace after the first finisher
  const st = a.last('race')!.standings;
  const me = st.find((s) => s.id === a.id)!;
  check(!!res && me.finishMs !== null, `A finished the race server-side in ${(me.finishMs! / 1000).toFixed(2)}s (sim ${(r.ms / 1000).toFixed(2)}s)`);
  check(Math.abs(me.finishMs! - r.ms) < 1500, 'server-tracked time within 1.5 s of the sim time');
  check(st[0].id === a.id && st.find((s) => s.id === b.id)!.finishMs === null, 'standings: A wins, B did not finish');
  a.ws.close(); b.ws.close();
}

if (scenario === 'tourney') {
  await pilot('tA', 'TourAlpha'); await pilot('tB', 'TourBravo');
  const a = new Bot('tA'), b = new Bot('tB');
  await a.open(); await b.open();
  a.send({ t: 'tqueue', v: true }); b.send({ t: 'tqueue', v: true });
  const q = await a.wait('tourney', (m) => m.state.queued.length === 2);
  check(true, `both queued; next start in ${Math.round((q.state.nextAt - Date.now()) / 1000)}s`);
  const qual = await a.wait('tourney', (m) => m.state.phase === 'qualifying', 130000);
  const mapId = qual.state.mapId!, laps = qual.state.laps;
  check(true, `qualifying opened on ${qual.state.mapName} (${laps} laps)`);
  // both fly the qualifier with live attestation (A unmodified autopilot; B a slower copy is not needed — same time is fine)
  const quals = await Promise.all([a, b].map(async (bot) => {
    bot.send({ t: 'att', op: 'start', mapId, laps, nonce: 1 });
    const att = await bot.wait('att');
    const f = await flyTrajectory(bot, mapId, laps, { attempt: att.id! });
    return submitRun(bot, mapId, laps, f.inputs, f.map, att.id!);
  }));
  check(quals.every((r: any) => r.ok), `qualifier runs verified (${quals.map((r: any) => r.ms ?? r.error).join(', ')})`);
  const ko = await a.wait('tourney', (m) => m.state.phase === 'knockout', 90000);
  check(ko.state.divisions.length === 1 && ko.state.divisions[0].players.length === 2, 'one division with both pilots');
  const room = await a.wait('room', (m) => m.room.mode === 'ko', 10000);
  check(!!room, `A was moved into knockout room ${room.room.id}`);
  await a.wait('phase', (m) => m.phase === 'running', 40000);
  await flyTrajectory(a, mapId, 1); // B idles → DNF
  const fin = await a.wait('tourney', (m) => m.state.phase === 'done', 60000);
  check(fin.state.divisions[0].winner === 'TourAlpha', `division winner: ${fin.state.divisions[0].winner}`);
  const stats = await (await fetch(`${BASE}/api/stats?sort=tourney_points`)).json();
  check(stats.stats.some((s: any) => s.player === 'TourAlpha' && s.tourney_wins === 1), 'tournament win recorded in stats');
  a.ws.close(); b.ws.close();
}

process.exit(fail ? 1 : 0);
