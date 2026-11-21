// Hourly tournament: queue → qualifier (validated time-trial runs) → divisions
// of 8 by qualifying time → knockout rounds in each division.
import type { Client, Hub } from './hub.ts';
import type { Pilot } from './auth.ts';
import type { TourneyState, CreateOpts } from '../shared/protocol.ts';
import { MAX_ROOM } from '../shared/protocol.ts';
import { KoRoom } from './rooms.ts';
import { resolveMap, worldFor, officialList } from './maps.ts';
import { rid } from './api.ts';

const EVERY_MIN = Number(process.env.TOURNEY_EVERY_MIN ?? 60);
const QUAL_MIN = Number(process.env.TOURNEY_QUAL_MIN ?? 10);
const MIN_PLAYERS = Number(process.env.TOURNEY_MIN_PLAYERS ?? 2);
const DONE_SHOW_MS = 3 * 60_000;

const nextSlot = (now: number) => {
  const step = EVERY_MIN * 60_000;
  return Math.floor(now / step) * step + step;
};

export class Tourney {
  id: string | null = null;
  phase: TourneyState['phase'] = 'idle';
  nextAt = nextSlot(Date.now());
  endsAt: number | null = null;
  mapId: string | null = null;
  mapName: string | null = null;
  laps = 1;
  queued = new Map<string, string>(); // uid -> name
  quals = new Map<string, { name: string; ms: number }>();
  divisions: { div: number; room: string; players: string[]; winner: string | null; uids: string[]; done: boolean; order: string[] }[] = [];
  private busy = false;
  private lastPush = 0;

  constructor(private hub: Hub) {}

  state(): TourneyState {
    return {
      id: this.id, phase: this.phase, nextAt: this.nextAt, endsAt: this.endsAt, mapId: this.mapId, mapName: this.mapName, laps: this.laps,
      queued: [...this.queued.values()].sort(), online: this.hub.onlineCount,
      qualifiers: [...this.quals.values()].sort((a, b) => a.ms - b.ms),
      divisions: this.divisions.map((d) => ({ div: d.div, room: d.room, players: d.players, winner: d.winner })),
      minPlayers: MIN_PLAYERS,
    };
  }

  push() {
    this.lastPush = Date.now();
    this.hub.broadcastAll({ t: 'tourney', state: this.state() });
  }

  queue(c: Client, v: boolean) {
    if (!c.uid) return;
    if (v) {
      if (this.phase === 'knockout') return c.send({ t: 'err', m: 'Knockouts already running — queue for the next one after it ends' });
      this.queued.set(c.uid, c.name);
      c.send({ t: 'notice', m: this.phase === 'qualifying' ? 'Joined! Qualifying is open now — fly the qualifier' : 'Queued for the next tournament' });
    } else this.queued.delete(c.uid);
    this.push();
  }

  dequeue(uid: string) {
    if (this.phase === 'idle' || this.phase === 'done') { if (this.queued.delete(uid)) this.push(); }
  }

  /** Called for every verified leaderboard run. */
  onRun(p: Pilot, mapId: string, laps: number, ms: number) {
    if (this.phase !== 'qualifying' || mapId !== this.mapId || laps !== this.laps || !this.queued.has(p.uid)) return;
    const cur = this.quals.get(p.uid);
    if (!cur || ms < cur.ms) {
      this.quals.set(p.uid, { name: p.name, ms });
      this.push();
    }
  }

  async tick(now: number) {
    if (this.busy) return;
    this.busy = true;
    try {
      if (this.phase === 'idle' && now >= this.nextAt) await this.startQualifying(now);
      else if (this.phase === 'qualifying' && now >= (this.endsAt ?? 0)) this.startKnockout(now);
      else if (this.phase === 'knockout' && this.divisions.every((d) => d.done)) await this.finish(now);
      else if (this.phase === 'done' && now >= (this.endsAt ?? 0)) { this.reset(now); this.push(); }
      if (now - this.lastPush > 15_000) this.push();
    } finally {
      this.busy = false;
    }
  }

  private reset(now: number) {
    this.phase = 'idle';
    this.id = null;
    this.endsAt = null;
    this.mapId = this.mapName = null;
    this.quals.clear();
    this.divisions = [];
    this.nextAt = nextSlot(now);
  }

  private async pickMap(): Promise<{ id: string; name: string; laps: number } | null> {
    // official maps plus well-rated community maps
    const pool: string[] = officialList().map((m) => m.id);
    const { rows } = await this.hub.db.query(
      `select id from drone_maps where not hidden and rating_count >= 2 and rating_sum >= rating_count * 4 order by random() limit 10`);
    pool.push(...rows.map((r) => r.id));
    const id = pool[Math.floor(Math.random() * pool.length)];
    const m = await resolveMap(this.hub.db, id);
    return m ? { id: m.id, name: m.map.name, laps: Math.min(m.map.laps, 3) } : null;
  }

  private async startQualifying(now: number) {
    const online = [...this.queued.keys()].filter((u) => this.hub.byUid.has(u));
    for (const u of [...this.queued.keys()]) if (!this.hub.byUid.has(u)) this.queued.delete(u);
    if (online.length < MIN_PLAYERS) {
      this.nextAt = nextSlot(now);
      if (online.length) for (const u of online) this.hub.byUid.get(u)?.send({ t: 'notice', m: `Not enough pilots queued (${online.length}/${MIN_PLAYERS}) — you stay queued for the next one` });
      this.push();
      return;
    }
    const map = await this.pickMap();
    if (!map) { this.nextAt = nextSlot(now); return; }
    this.id = rid(10);
    this.phase = 'qualifying';
    this.mapId = map.id;
    this.mapName = map.name;
    this.laps = map.laps;
    this.endsAt = now + QUAL_MIN * 60_000;
    this.quals.clear();
    for (const u of online) this.hub.byUid.get(u)?.send({ t: 'notice', m: `Tournament qualifying is open on ${map.name}! Best ${map.laps}-lap time in ${QUAL_MIN} minutes` });
    this.push();
  }

  private startKnockout(now: number) {
    const qualified = [...this.quals.entries()].sort((a, b) => a[1].ms - b[1].ms);
    if (qualified.length < MIN_PLAYERS) {
      for (const u of this.queued.keys()) this.hub.byUid.get(u)?.send({ t: 'notice', m: 'Tournament cancelled: not enough qualifying times' });
      this.reset(now);
      this.push();
      return;
    }
    this.phase = 'knockout';
    this.endsAt = null;
    const m = this.mapId!;
    const nDiv = Math.ceil(qualified.length / MAX_ROOM);
    // spread evenly so the last division isn't a lonely 1-2 pilots
    const per = Math.ceil(qualified.length / nDiv);
    resolveMap(this.hub.db, m).then((res) => {
      if (!res) return;
      for (let d = 0; d < nDiv; d++) {
        const slice = qualified.slice(d * per, (d + 1) * per);
        const roster = new Map(slice.map(([uid, q]) => [uid, q.name]));
        const opts: CreateOpts = { mode: 'ko', mapId: m, laps: 1, collide: false, priv: true, max: MAX_ROOM, teamSize: 0 };
        const room = new KoRoom(this.hub, this.hub.newRoomId(), opts, res.map, worldFor(m, res.map), res.map.name, d + 1, roster, res.meta?.authorMs ?? 60_000);
        this.hub.rooms.set(room.id, room);
        const div = { div: d + 1, room: room.id, players: slice.map(([, q]) => q.name), winner: null as string | null, uids: slice.map(([u]) => u), done: false, order: [] as string[] };
        room.onDone = (winner, order) => { div.winner = winner; div.done = true; div.order = order; this.push(); };
        this.divisions.push(div);
        for (const [uid] of slice) {
          const c = this.hub.byUid.get(uid);
          if (c) { this.hub.join(c, room); c.send({ t: 'notice', m: `Division ${d + 1} knockout starting!` }); }
        }
      }
      this.push();
    });
    for (const u of this.queued.keys()) if (!this.quals.has(u)) this.hub.byUid.get(u)?.send({ t: 'notice', m: 'You did not post a qualifying time this round' });
  }

  private async finish(now: number) {
    this.phase = 'done';
    this.endsAt = now + DONE_SHOW_MS;
    for (const d of this.divisions) {
      d.order.forEach((name, i) => {
        const uid = d.uids[d.players.indexOf(name)];
        if (!uid) return;
        const place = i + 1;
        const points = Math.max(1, Math.round(((MAX_ROOM + 1 - place) * 10) / d.div));
        this.hub.addStats({ uid, name }, { tourneys: 1, tourney_points: points, ...(place === 1 && d.div === 1 ? { tourney_wins: 1 } : {}) });
      });
      // pilots who qualified but never showed get the participation entry only
      for (let i = 0; i < d.uids.length; i++) if (!d.order.includes(d.players[i])) this.hub.addStats({ uid: d.uids[i], name: d.players[i] }, { tourneys: 1 });
    }
    await this.hub.db.query('insert into drone_tourneys (id, map_id, started_at, data) values ($1,$2,now(),$3)', [
      this.id, this.mapId, JSON.stringify({ mapName: this.mapName, qualifiers: this.state().qualifiers, divisions: this.divisions.map(({ div, players, winner, order }) => ({ div, players, winner, order })) }),
    ]).catch((e) => console.error('[tourney]', e));
    this.queued.clear();
    this.push();
  }
}
