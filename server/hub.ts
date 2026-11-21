// WebSocket hub: identity, presence, friends, DMs, invites, room routing.
import type { WebSocket } from 'ws';
import type { Db } from './db.ts';
import { verifyToken, pilotFor } from './auth.ts';
import { limited, rid } from './api.ts';
import { sanitizeSkin, type Skin } from '../shared/skins.ts';
import type { C2S, S2C, CreateOpts, RoomMode, TeamSize, FriendInfo } from '../shared/protocol.ts';
import type { V3, Q4 } from '../shared/math.ts';
import { Room, createRoom } from './rooms.ts';
import { Tourney } from './tourney.ts';

export interface NetState { p: V3; q: Q4; v: V3; yaw: number; pitch: number; at: number }

export class Client {
  id = rid(8);
  uid: string | null = null;
  name = `Guest-${Math.floor(1000 + Math.random() * 9000)}`;
  skin: Skin = sanitizeSkin(null);
  premium = false;
  admin = false;
  room: Room | null = null;
  state: NetState | null = null;
  hist: { at: number; p: V3 }[] = [];
  ping = 0;
  activity = 'In menus';
  friendUids = new Set<string>();
  ready = false;
  helloDone = false;
  constructor(public ws: WebSocket) {}
  get guest() { return !this.uid; }
  send(m: S2C) { if (this.ws.readyState === 1) this.ws.send(JSON.stringify(m)); }
}

export interface Attempt { id: string; uid: string; clientId: string; mapId: string; laps: number; startAt: number; hb: { tick: number; h: number; at: number }[]; used: boolean }

export class Hub {
  attempts = new Map<string, Attempt>();
  clients = new Map<string, Client>();
  byUid = new Map<string, Client>();
  rooms = new Map<string, Room>();
  tourney: Tourney;

  constructor(public db: Db) {
    this.tourney = new Tourney(this);
    setInterval(() => this.tick(), 50).unref();
    setInterval(() => this.sweepAttempts(), 60_000).unref();
  }

  get onlineCount() { return this.clients.size; }

  attach(ws: WebSocket) {
    const c = new Client(ws);
    this.clients.set(c.id, c);
    ws.on('message', (buf) => {
      if (limited(`ws:${c.id}`, 200, 1000)) return; // ~20 Hz states + bursts of fire is far below this
      let msg: C2S;
      try { msg = JSON.parse(buf.toString()); } catch { return; }
      this.handle(c, msg).catch((e) => console.error('[hub]', e));
    });
    ws.on('close', () => this.drop(c));
    ws.on('error', () => ws.close());
  }

  private drop(c: Client) {
    c.room?.leave(c);
    this.clients.delete(c.id);
    if (c.uid && this.byUid.get(c.uid) === c) {
      this.byUid.delete(c.uid);
      this.tourney.dequeue(c.uid);
      this.presenceChanged(c);
    }
    this.broadcastOnline();
  }

  private async handle(c: Client, m: C2S) {
    if (m.t === 'ping') return c.send({ t: 'pong', c: m.c, s: Date.now() });
    if (m.t === 'hello') return this.hello(c, m.token, m.skin);
    if (!c.helloDone) return;
    switch (m.t) {
      case 'list':
        return c.send({ t: 'rooms', list: [...this.rooms.values()].filter((r) => !r.opts.priv && r.mode !== 'ko').map((r) => r.info()) });
      case 'create': return this.create(c, m.opts);
      case 'join': {
        const r = this.rooms.get(String(m.id).toUpperCase());
        if (!r) return c.send({ t: 'err', m: 'Room not found' });
        return this.join(c, r);
      }
      case 'quick': return this.quick(c, m.mode, m.teamSize ?? 0);
      case 'leave':
        c.room?.leave(c);
        c.send({ t: 'left' });
        return this.setActivity(c, 'In menus');
      case 'activity':
        if (!c.room) return this.setActivity(c, String(m.a).slice(0, 60));
        return;
      case 'tqueue':
        if (!c.uid) return c.send({ t: 'err', m: 'Sign in to enter tournaments' });
        return this.tourney.queue(c, !!m.v);
      case 'att': return this.attest(c, m);
      case 'friend': return this.friendOp(c, m.op, String(m.name ?? ''));
      case 'dm': return this.dm(c, String(m.to ?? ''), String(m.m ?? ''));
      case 'invite': return this.invite(c, String(m.to ?? ''));
      case 'chat': {
        if (!c.room || limited(`chat:${c.id}`, 6, 5000)) return;
        const text = String(m.m ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 200);
        if (text) c.room.broadcast({ t: 'chat', from: c.name, m: text });
        return;
      }
      default:
        c.room?.onMsg(c, m);
    }
  }

  private async hello(c: Client, token: string | null, skin: unknown) {
    const ident = await verifyToken(token);
    const pilot = ident ? await pilotFor(this.db, ident.uid) : null;
    if (pilot) {
      const old = this.byUid.get(pilot.uid);
      if (old && old !== c) { old.send({ t: 'notice', m: 'Signed in from another tab' }); old.ws.close(); }
      c.uid = pilot.uid;
      c.name = pilot.name;
      c.premium = pilot.premium;
      c.admin = pilot.admin;
      this.byUid.set(pilot.uid, c);
    }
    c.skin = sanitizeSkin(skin, c.premium);
    c.helloDone = true;
    c.send({ t: 'welcome', id: c.id, name: c.name, uid: c.uid, premium: c.premium, admin: c.admin });
    c.send({ t: 'tourney', state: this.tourney.state() });
    if (c.uid) {
      await this.pushFriends(c);
      this.presenceChanged(c);
    }
    this.broadcastOnline();
  }

  // ---------------------------------------------------------------- rooms

  private async create(c: Client, o: Partial<CreateOpts>) {
    const mode: RoomMode = (['race', 'freeroam', 'pvp', 'tt'] as RoomMode[]).includes(o.mode as RoomMode) ? (o.mode as RoomMode) : 'race';
    const teamSize = ([0, 2, 3, 4] as TeamSize[]).includes(o.teamSize as TeamSize) ? (o.teamSize as TeamSize) : 0;
    const opts: CreateOpts = {
      mode,
      mapId: mode === 'pvp' ? `pvp:${Math.floor(Math.random() * 1e9)}` : String(o.mapId ?? 'o:meadow-loop'),
      laps: Math.max(1, Math.min(10, Math.floor(Number(o.laps) || 3))),
      collide: o.collide !== false,
      priv: !!o.priv,
      max: teamSize ? teamSize * 2 : Math.max(2, Math.min(8, Math.floor(Number(o.max) || 8))),
      teamSize,
    };
    const room = await createRoom(this, this.newRoomId(), opts, c.id);
    if (!room) return c.send({ t: 'err', m: 'Map not found' });
    this.rooms.set(room.id, room);
    this.join(c, room);
  }

  newRoomId() {
    const A = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
    let id = '';
    do { id = Array.from({ length: 5 }, () => A[Math.floor(Math.random() * A.length)]).join(''); } while (this.rooms.has(id));
    return id;
  }

  join(c: Client, r: Room) {
    if (c.room === r) return;
    if (r.players.size >= r.opts.max) return c.send({ t: 'err', m: 'Room is full' });
    if (r.mode === 'ko' && !r.canJoin(c)) return c.send({ t: 'err', m: 'Tournament room' });
    c.room?.leave(c);
    r.join(c);
    this.setActivity(c, r.activity());
  }

  private async quick(c: Client, mode: RoomMode, teamSize: TeamSize) {
    const open = [...this.rooms.values()].find((r) =>
      r.mode === mode && !r.opts.priv && r.players.size < r.opts.max && (mode !== 'pvp' || r.opts.teamSize === teamSize) && (mode !== 'race' || r.phase === 'lobby'));
    if (open) return this.join(c, open);
    const maps = ['o:meadow-loop', 'o:canyon-run', 'o:lakeside', 'o:neon-city', 'o:alpine'];
    return this.create(c, { mode, teamSize, mapId: maps[Math.floor(Math.random() * maps.length)], laps: 3, collide: true, priv: false, max: 8 });
  }

  removeRoom(r: Room) { this.rooms.delete(r.id); }

  private tick() {
    const now = Date.now();
    for (const r of this.rooms.values()) r.tick(now);
    this.tourney.tick(now);
  }

  broadcastOnline() {
    if (limited('online-bcast', 1, 1000)) return;
    const n = this.onlineCount;
    for (const c of this.clients.values()) c.send({ t: 'online', n });
  }

  broadcastAll(m: S2C) { for (const c of this.clients.values()) if (c.helloDone) c.send(m); }

  // ---------------------------------------------------------------- run attestation

  private attest(c: Client, m: Extract<C2S, { t: 'att' }>) {
    if (m.op === 'start') {
      if (!c.uid) return c.send({ t: 'att', nonce: m.nonce, id: null, err: 'sign in to post times' });
      if (limited(`att:${c.uid}`, 120, 60_000)) return c.send({ t: 'att', nonce: m.nonce, id: null, err: 'too many attempts' });
      // one live attempt per connection: quick-restart replaces it
      for (const [k, a] of this.attempts) if (a.clientId === c.id && !a.used) this.attempts.delete(k);
      const id = rid(16);
      this.attempts.set(id, { id, uid: c.uid, clientId: c.id, mapId: String(m.mapId).slice(0, 80), laps: Math.floor(Number(m.laps)) || 1, startAt: Date.now(), hb: [], used: false });
      return c.send({ t: 'att', nonce: m.nonce, id });
    }
    const a = this.attempts.get(m.id);
    if (!a || a.clientId !== c.id || a.used || !Number.isInteger(m.tick) || !Number.isInteger(m.h)) return;
    const last = a.hb[a.hb.length - 1];
    if (last && m.tick <= last.tick) return;
    if (a.hb.length < 4000) a.hb.push({ tick: m.tick, h: m.h >>> 0, at: Date.now() });
  }

  /** One-shot: an attempt can back exactly one submission. */
  takeAttempt(id: unknown, uid: string, mapId: string, laps: number): Attempt | string {
    const a = typeof id === 'string' ? this.attempts.get(id) : undefined;
    if (!a) return 'this run was not flown live with this server (or the server restarted) — fly it again';
    if (a.used) return 'this run was already submitted';
    if (a.uid !== uid || a.mapId !== mapId || a.laps !== laps) return 'attempt does not match this run';
    a.used = true;
    return a;
  }

  private sweepAttempts() {
    const cutoff = Date.now() - 40 * 60_000;
    for (const [k, a] of this.attempts) if (a.startAt < cutoff) this.attempts.delete(k);
  }

  // ---------------------------------------------------------------- friends / social

  setActivity(c: Client, a: string) {
    c.activity = a;
    if (c.uid) this.presenceChanged(c);
  }

  private async presenceChanged(c: Client) {
    if (!c.uid) return;
    for (const fu of c.friendUids) {
      const f = this.byUid.get(fu);
      if (f) await this.pushFriends(f);
    }
  }

  async pushFriends(c: Client) {
    if (!c.uid) return;
    const { rows } = await this.db.query(
      `select f.a, f.b, f.status, pa.name as aname, pb.name as bname from drone_friends f
       join drone_pilots pa on pa.uid = f.a join drone_pilots pb on pb.uid = f.b where f.a = $1 or f.b = $1`, [c.uid]);
    const list: FriendInfo[] = [];
    const incoming: string[] = [], outgoing: string[] = [];
    c.friendUids.clear();
    for (const r of rows) {
      const mine = r.a === c.uid;
      const otherUid = mine ? r.b : r.a, otherName = mine ? r.bname : r.aname;
      if (r.status === 'accepted') {
        c.friendUids.add(otherUid);
        const o = this.byUid.get(otherUid);
        list.push({ name: otherName, online: !!o, activity: o?.activity ?? null, room: o?.room && !o.room.opts.priv ? o.room.id : null });
      } else if (mine) outgoing.push(otherName);
      else incoming.push(otherName);
    }
    list.sort((x, y) => Number(y.online) - Number(x.online) || x.name.localeCompare(y.name));
    c.send({ t: 'friends', list, incoming, outgoing });
  }

  private async uidOf(name: string): Promise<{ uid: string; name: string } | null> {
    const { rows } = await this.db.query('select uid, name from drone_pilots where name_lc = $1 and not banned', [name.toLowerCase()]);
    return rows[0] ?? null;
  }

  private async friendOp(c: Client, op: string, name: string) {
    if (!c.uid) return c.send({ t: 'err', m: 'Sign in to add friends' });
    if (limited(`friend:${c.uid}`, 30, 60_000)) return;
    const o = await this.uidOf(name);
    if (!o || o.uid === c.uid) return c.send({ t: 'err', m: 'No pilot with that name' });
    if (op === 'add') {
      const rev = await this.db.query('select status from drone_friends where a = $1 and b = $2', [o.uid, c.uid]);
      if (rev.rows[0]) await this.db.query(`update drone_friends set status = 'accepted' where a = $1 and b = $2`, [o.uid, c.uid]);
      else {
        const cnt = await this.db.query('select count(*)::int as n from drone_friends where a = $1 or b = $1', [c.uid]);
        if (cnt.rows[0].n >= 200) return c.send({ t: 'err', m: 'Friend list full' });
        await this.db.query(`insert into drone_friends (a, b, status) values ($1, $2, 'pending') on conflict do nothing`, [c.uid, o.uid]);
        this.byUid.get(o.uid)?.send({ t: 'notice', m: `${c.name} sent you a friend request` });
      }
    } else if (op === 'accept') {
      await this.db.query(`update drone_friends set status = 'accepted' where a = $1 and b = $2`, [o.uid, c.uid]);
    } else {
      await this.db.query('delete from drone_friends where (a = $1 and b = $2) or (a = $2 and b = $1)', [c.uid, o.uid]);
    }
    await this.pushFriends(c);
    const other = this.byUid.get(o.uid);
    if (other) await this.pushFriends(other);
  }

  private async dm(c: Client, to: string, text: string) {
    if (!c.uid) return;
    text = text.replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
    if (!text || limited(`dm:${c.uid}`, 20, 30_000)) return;
    const o = await this.uidOf(to);
    if (!o || !c.friendUids.has(o.uid)) return c.send({ t: 'err', m: 'You can only message friends' });
    const [a, b] = [c.uid, o.uid].sort();
    await this.db.query('insert into drone_dms (a, b, sender, body) values ($1,$2,$3,$4)', [a, b, c.uid, text]);
    const msg: S2C = { t: 'dm', from: c.name, to: o.name, m: text, at: Date.now() };
    c.send(msg);
    this.byUid.get(o.uid)?.send(msg);
  }

  private async invite(c: Client, to: string) {
    if (!c.uid || !c.room) return c.send({ t: 'err', m: 'Join or create a room first' });
    if (limited(`invite:${c.uid}`, 10, 60_000)) return;
    const o = await this.uidOf(to);
    const f = o && c.friendUids.has(o.uid) ? this.byUid.get(o.uid) : null;
    if (!f) return c.send({ t: 'err', m: `${to} is not online` });
    f.send({ t: 'invite', from: c.name, room: c.room.info() });
    c.send({ t: 'notice', m: `Invited ${o!.name}` });
  }

  async addStats(c: { uid: string | null; name: string }, delta: Partial<Record<'races' | 'race_wins' | 'kills' | 'deaths' | 'pvp_matches' | 'pvp_wins' | 'tourneys' | 'tourney_wins' | 'tourney_points', number>>) {
    if (!c.uid) return;
    const keys = Object.keys(delta) as (keyof typeof delta)[];
    if (!keys.length) return;
    const cols = keys.join(', ');
    const vals = keys.map((_, i) => `$${i + 3}`).join(', ');
    const upd = keys.map((k, i) => `${k} = drone_stats.${k} + $${i + 3}`).join(', ');
    await this.db.query(
      `insert into drone_stats (uid, player, ${cols}) values ($1, $2, ${vals}) on conflict (uid) do update set player = $2, ${upd}`,
      [c.uid, c.name, ...keys.map((k) => delta[k])]).catch((e) => console.error('[stats]', e));
  }
}
