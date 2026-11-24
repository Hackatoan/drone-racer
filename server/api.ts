import express, { type Request, type Response, type NextFunction } from 'express';
import { randomBytes } from 'node:crypto';
import type { Db } from './db.ts';
import { authOf, NAME_RE, authConfig, isAdminUid, type Pilot, type Identity } from './auth.ts';
import { resolveMap, officialList, rowMeta, parseRunFile, verifyRun, worldFor, makeRunFile } from './maps.ts';
import { sanitizeMap } from '../shared/map.ts';
import { mapHash, checkHeartbeats, inputsDigest, type RunFile, type QInput } from '../shared/replay.ts';
import { premiumRoutes } from './stripe.ts';
import type { Hub } from './hub.ts';

export const rid = (n = 12) => randomBytes(n).toString('base64url').replace(/[^a-z0-9]/gi, '').toLowerCase().slice(0, n).padEnd(n, '0');

// --- tiny fixed-window limiter
const hits = new Map<string, { n: number; reset: number }>();
export function limited(key: string, max: number, windowMs: number) {
  const now = Date.now();
  const h = hits.get(key);
  if (!h || h.reset < now) { hits.set(key, { n: 1, reset: now + windowMs }); return false; }
  return ++h.n > max;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of hits) if (v.reset < now) hits.delete(k); }, 60_000).unref();

type AuthedReq = Request & { ident?: Identity; pilot?: Pilot };
const bad = (res: Response, code: number, error: string) => res.status(code).json({ error });
const ip = (req: Request) => (req.headers['x-forwarded-for'] as string)?.split(',')[0].trim() || req.socket.remoteAddress || '?';

const REPORT_KINDS = ['map', 'run', 'review', 'texture', 'pilot'] as const;
const AUTO_HIDE = 3;

export function apiRouter(db: Db, hub: Hub) {
  const r = express.Router();
  r.use(express.json({ limit: '4mb' }));

  const auth = (need: 'ident' | 'pilot' | 'admin') => async (req: AuthedReq, res: Response, next: NextFunction) => {
    const a = await authOf(db, req);
    if (!a.id) return bad(res, 401, 'sign in required');
    req.ident = a.id;
    if (need !== 'ident' && !a.pilot) return bad(res, 409, 'choose a pilot name first');
    if (need === 'admin' && !a.pilot!.admin) return bad(res, 403, 'admins only');
    req.pilot = a.pilot ?? undefined;
    next();
  };

  r.get('/config', (_req, res) => {
    let firebase = null;
    try { firebase = process.env.FIREBASE_WEB_CONFIG ? JSON.parse(process.env.FIREBASE_WEB_CONFIG) : null; } catch { /* ignore */ }
    res.json({ firebase, devAuth: authConfig().dev, stripe: !!process.env.STRIPE_SECRET_KEY });
  });

  // ------------------------------------------------------------ account
  r.get('/me', auth('ident'), (req: AuthedReq, res) => res.json({ uid: req.ident!.uid, pilot: req.pilot ?? null }));

  r.post('/me/name', auth('ident'), async (req: AuthedReq, res) => {
    const name = String(req.body?.name ?? '').trim();
    if (!NAME_RE.test(name)) return bad(res, 400, '3-16 letters, numbers, _ or -');
    // req.pilot is null until a name is claimed, so check the admin list by uid.
    if (/^(guest|autopilot|admin|hackatoa|system)/i.test(name) && !isAdminUid(req.ident!.uid)) return bad(res, 400, 'that name is reserved');
    if (req.pilot) return bad(res, 400, 'you already have a pilot name');
    try {
      await db.query('insert into drone_pilots (uid, name, name_lc) values ($1, $2, $3)', [req.ident!.uid, name, name.toLowerCase()]);
    } catch {
      return bad(res, 409, 'name taken');
    }
    res.json({ ok: true, name });
  });

  // ------------------------------------------------------------ maps
  r.get('/maps', async (req, res) => {
    const tab = req.query.tab === 'official' ? 'official' : 'community';
    if (tab === 'official') return res.json({ maps: officialList() });
    const sort = String(req.query.sort ?? 'new');
    const order = sort === 'plays' ? 'plays desc' : sort === 'rating' ? '(rating_sum::float / greatest(rating_count, 1)) desc, rating_count desc' : sort === 'top' ? '(plays + rating_sum * 3) desc' : 'created_at desc';
    const q = String(req.query.q ?? '').slice(0, 40);
    const offset = Math.max(0, Math.min(5000, Number(req.query.offset) || 0));
    const { rows } = await db.query(
      `select id, name, author, descr, laps, checkpoints, author_ms, plays, rating_sum, rating_count, thumb, created_at, data->>'sky' as sky
       from drone_maps where not hidden and ($1 = '' or name ilike '%' || $1 || '%' or author ilike '%' || $1 || '%')
       order by ${order} limit 30 offset $2`, [q, offset]);
    res.json({ maps: rows.map((x) => rowMeta({ ...x, data: { sky: x.sky } })) });
  });

  r.get('/maps/:id', async (req, res) => {
    const m = await resolveMap(db, req.params.id);
    if (!m) return bad(res, 404, 'map not found');
    res.json({ id: m.id, meta: m.meta, map: m.map, hash: m.hash });
  });

  r.get('/maps/:id/author-run', async (req, res) => {
    const m = await resolveMap(db, req.params.id);
    if (!m?.authorRun) return bad(res, 404, 'no author run');
    res.json(m.authorRun);
  });

  r.post('/maps/:id/play', async (req, res) => {
    const pid = String(req.params.id);
    if (!pid.startsWith('c:') || limited(`play:${ip(req)}:${pid}`, 1, 10 * 60_000)) return res.json({ ok: true });
    await db.query('update drone_maps set plays = plays + 1 where id = $1', [req.params.id]);
    res.json({ ok: true });
  });

  /** Publish: the map must come with the author's own finished run on exactly this map. */
  r.post('/maps', auth('pilot'), async (req: AuthedReq, res) => {
    if (limited(`publish:${req.pilot!.uid}`, 8, 3600_000)) return bad(res, 429, 'publishing too fast, try later');
    const map = sanitizeMap(req.body?.map);
    map.author = req.pilot!.name;
    if (map.checkpoints.length < 1) return bad(res, 400, 'add at least one checkpoint');
    const run = parseRunFile(req.body?.run);
    if (!run) return bad(res, 400, 'validate the map first: fly a full run and publish with it');
    if (run.laps !== map.laps) return bad(res, 400, `validation run must be ${map.laps} laps`);
    const hash = mapHash(map);
    const id = `c:${rid(10)}`;
    const v = verifyRun(map, worldFor(`pending:${hash}`, map), hash, run);
    if (!v.ok) return bad(res, 400, `validation run rejected: ${v.reason}`);
    const att = await attestation(db, hub, req.pilot!, `draft:${hash}`, run, v.inputs, v.ticks);
    if (att) return bad(res, 400, `validation run rejected: ${att}`);
    const thumb = typeof req.body?.thumb === 'string' && /^data:image\/(png|jpeg|webp);base64,[A-Za-z0-9+/=]+$/.test(req.body.thumb) && req.body.thumb.length < 80_000 ? req.body.thumb : null;
    const authorRun = { ...makeRunFile(id, map, hash, req.pilot!.name, v.inputs, v.ms, v.lapTimes), mode: run.mode, rates: run.rates, skin: run.skin };
    await db.query(
      `insert into drone_maps (id, name, author, author_uid, descr, data, hash, thumb, laps, checkpoints, author_ms, author_run)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12)`,
      [id, map.name, map.author, req.pilot!.uid, map.desc, JSON.stringify(map), hash, thumb, map.laps, map.checkpoints.length, v.ms, JSON.stringify(authorRun)],
    );
    // the author's validation run also seeds the leaderboard
    await upsertRun(db, id, map.laps, req.pilot!, v.ms, v.lapTimes, authorRun);
    res.json({ ok: true, id, authorMs: v.ms });
  });

  // ------------------------------------------------------------ reviews
  r.get('/maps/:id/reviews', async (req, res) => {
    const { rows } = await db.query('select player, stars, body, created_at, uid from drone_reviews where map_id = $1 and not hidden order by created_at desc limit 100', [req.params.id]);
    res.json({ reviews: rows.map((x) => ({ player: x.player, stars: x.stars, body: x.body, at: x.created_at, id: `${req.params.id}|${x.uid}` })) });
  });

  r.post('/maps/:id/reviews', auth('pilot'), async (req: AuthedReq, res) => {
    const id = String(req.params.id);
    if (!id.startsWith('c:')) return bad(res, 400, 'official maps are not rated');
    const stars = Math.round(Number(req.body?.stars));
    if (!(stars >= 1 && stars <= 5)) return bad(res, 400, 'stars 1-5');
    const body = String(req.body?.body ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 500);
    const m = await db.query('select author_uid from drone_maps where id = $1', [id]);
    if (!m.rows[0]) return bad(res, 404, 'map not found');
    if (m.rows[0].author_uid === req.pilot!.uid) return bad(res, 400, "you can't rate your own map");
    const prev = await db.query('select stars from drone_reviews where map_id = $1 and uid = $2', [id, req.pilot!.uid]);
    await db.query(
      `insert into drone_reviews (map_id, uid, player, stars, body) values ($1,$2,$3,$4,$5)
       on conflict (map_id, uid) do update set stars = $4, body = $5, created_at = now()`, [id, req.pilot!.uid, req.pilot!.name, stars, body]);
    const old = prev.rows[0]?.stars;
    await db.query('update drone_maps set rating_sum = rating_sum + $2, rating_count = rating_count + $3 where id = $1', [id, stars - (old ?? 0), old ? 0 : 1]);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ runs / leaderboards
  r.get('/runs', async (req, res) => {
    const map = String(req.query.map ?? '');
    const laps = Number(req.query.laps) || 0;
    const { rows } = await db.query(
      `select id, player, ms, lap_times, mode, created_at from drone_runs where map_id = $1 and laps = $2 and not hidden order by ms asc, created_at asc limit 100`, [map, laps]);
    const lapsAvail = await db.query('select laps, count(*)::int as n from drone_runs where map_id = $1 and not hidden group by laps order by laps', [map]);
    res.json({ runs: rows.map((x, i) => ({ rank: i + 1, id: x.id, player: x.player, ms: x.ms, lapTimes: x.lap_times, mode: x.mode, at: x.created_at })), laps: lapsAvail.rows });
  });

  r.get('/runs/:id', async (req, res) => {
    const { rows } = await db.query('select run from drone_runs where id = $1 and not hidden', [req.params.id]);
    if (!rows[0]) return bad(res, 404, 'run not found');
    res.json(rows[0].run);
  });

  r.post('/runs', auth('pilot'), async (req: AuthedReq, res) => {
    if (limited(`run:${req.pilot!.uid}`, 30, 60_000)) return bad(res, 429, 'slow down');
    const run = parseRunFile(req.body?.run);
    if (!run) return bad(res, 400, 'not a run file');
    const m = await resolveMap(db, run.mapId);
    if (!m || m.id.startsWith('pvp:')) return bad(res, 404, 'map not found');
    const v = verifyRun(m.map, worldFor(m.id, m.map), m.hash, run);
    if (!v.ok) return res.status(400).json({ error: `run rejected: ${v.reason}` });
    const att = await attestation(db, hub, req.pilot!, m.id, run, v.inputs, v.ticks);
    if (att) return res.status(400).json({ error: `run rejected: ${att}` });
    const stored = { ...run, attempt: undefined, player: req.pilot!.name, claimedMs: v.ms, lapTimes: v.lapTimes, ticks: v.inputs.length };
    const pb = await upsertRun(db, m.id, run.laps, req.pilot!, v.ms, v.lapTimes, stored);
    hub.tourney.onRun(req.pilot!, m.id, run.laps, v.ms);
    const rank = await db.query('select count(*)::int + 1 as rank from drone_runs where map_id = $1 and laps = $2 and ms < $3 and not hidden', [m.id, run.laps, v.ms]);
    res.json({ ok: true, ms: v.ms, lapTimes: v.lapTimes, pb, rank: rank.rows[0].rank, claimed: run.claimedMs });
  });

  r.get('/stats', async (req, res) => {
    const cols: Record<string, string> = { race_wins: 'race_wins', kills: 'kills', pvp_wins: 'pvp_wins', tourney_points: 'tourney_points', tourney_wins: 'tourney_wins' };
    const col = cols[String(req.query.sort)] ?? 'tourney_points';
    const { rows } = await db.query(`select player, races, race_wins, kills, deaths, pvp_matches, pvp_wins, tourneys, tourney_wins, tourney_points from drone_stats order by ${col} desc, player asc limit 100`);
    res.json({ stats: rows });
  });

  r.get('/tourneys', async (_req, res) => {
    const { rows } = await db.query('select id, map_id, started_at, data from drone_tourneys order by started_at desc limit 20');
    res.json({ tourneys: rows, current: hub.tourney.state() });
  });

  // ------------------------------------------------------------ reports + moderation
  r.post('/reports', auth('pilot'), async (req: AuthedReq, res) => {
    const kind = String(req.body?.kind);
    const target = String(req.body?.target ?? '').slice(0, 120);
    const reason = String(req.body?.reason ?? '').replace(/[\u0000-\u001f]/g, ' ').trim().slice(0, 300);
    if (!(REPORT_KINDS as readonly string[]).includes(kind) || !target || reason.length < 3) return bad(res, 400, 'pick a reason');
    if (limited(`report:${req.pilot!.uid}`, 20, 3600_000)) return bad(res, 429, 'too many reports');
    try {
      await db.query('insert into drone_reports (kind, target, reason, reporter_uid) values ($1,$2,$3,$4)', [kind, target, reason, req.pilot!.uid]);
    } catch { return res.json({ ok: true, dup: true }); }
    const { rows } = await db.query(`select count(*)::int as n from drone_reports where kind = $1 and target = $2 and status = 'open'`, [kind, target]);
    if (rows[0].n >= AUTO_HIDE) await setHidden(db, kind, target, true);
    res.json({ ok: true });
  });

  r.get('/admin/reports', auth('admin'), async (_req, res) => {
    const { rows } = await db.query(
      `select kind, target, count(*)::int as n, array_agg(reason order by created_at desc) as reasons, min(created_at) as first
       from drone_reports where status = 'open' group by kind, target order by n desc, first asc limit 200`);
    res.json({ reports: rows });
  });

  r.post('/admin/action', auth('admin'), async (req: AuthedReq, res) => {
    const { kind, target, action } = req.body ?? {};
    if (!(REPORT_KINDS as readonly string[]).includes(kind) || typeof target !== 'string') return bad(res, 400, 'bad target');
    if (action === 'remove') await setHidden(db, kind, target, true);
    else if (action === 'restore' || action === 'dismiss') await setHidden(db, kind, target, false);
    else return bad(res, 400, 'action: remove | restore | dismiss');
    await db.query(`update drone_reports set status = $3 where kind = $1 and target = $2 and status = 'open'`, [kind, target, action === 'remove' ? 'removed' : 'dismissed']);
    res.json({ ok: true });
  });

  // ------------------------------------------------------------ textures
  r.get('/textures', async (req, res) => {
    const a = await authOf(db, req);
    const mine = req.query.mine === '1' && a.id;
    const { rows } = await db.query(
      mine ? 'select id, name, purpose, uid from drone_textures where uid = $1 and not hidden order by created_at desc limit 100'
           : `select id, name, purpose, uid from drone_textures where purpose = 'map' and not hidden and $1::text is not null order by created_at desc limit 60`,
      [mine ? a.id!.uid : 'x']);
    res.json({ textures: rows.map((t) => ({ id: t.id, key: `u:${t.id}`, name: t.name, purpose: t.purpose, mine: a.id?.uid === t.uid })) });
  });

  r.get('/textures/:id', async (req, res) => {
    const { rows } = await db.query('select mime, bytes from drone_textures where id = $1 and not hidden', [req.params.id]);
    if (!rows[0]) return res.status(404).end();
    res.setHeader('Content-Type', rows[0].mime);
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'none'");
    res.end(Buffer.from(rows[0].bytes));
  });

  r.post('/textures', auth('pilot'), async (req: AuthedReq, res) => {
    const purpose = req.body?.purpose === 'skin' ? 'skin' : 'map';
    if (purpose === 'skin' && !req.pilot!.premium) return bad(res, 402, 'custom drone skins are a Premium feature');
    if (limited(`tex:${req.pilot!.uid}`, 20, 3600_000)) return bad(res, 429, 'too many uploads');
    const m = /^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body?.data ?? ''));
    if (!m) return bad(res, 400, 'PNG, JPEG or WebP only');
    const bytes = Buffer.from(m[2], 'base64');
    if (bytes.length > 300_000) return bad(res, 400, 'max 300 KB');
    const magic = bytes.subarray(0, 12);
    const ok = (m[1] === 'image/png' && magic[0] === 0x89 && magic[1] === 0x50) || (m[1] === 'image/jpeg' && magic[0] === 0xff && magic[1] === 0xd8) || (m[1] === 'image/webp' && magic.toString('latin1', 8, 12) === 'WEBP');
    if (!ok) return bad(res, 400, 'file content does not match its type');
    const count = await db.query('select count(*)::int as n from drone_textures where uid = $1', [req.pilot!.uid]);
    if (count.rows[0].n >= 60) return bad(res, 400, 'texture limit reached (60)');
    const id = rid(14);
    const name = String(req.body?.name ?? 'texture').replace(/[^\w .-]/g, '').slice(0, 32) || 'texture';
    await db.query('insert into drone_textures (id, uid, name, mime, bytes, purpose) values ($1,$2,$3,$4,$5,$6)', [id, req.pilot!.uid, name, m[1], bytes, purpose]);
    res.json({ ok: true, id, key: `u:${id}` });
  });

  // ------------------------------------------------------------ messages
  r.get('/dms', auth('pilot'), async (req: AuthedReq, res) => {
    const other = String(req.query.with ?? '');
    const o = await db.query('select uid from drone_pilots where name_lc = $1', [other.toLowerCase()]);
    if (!o.rows[0]) return bad(res, 404, 'no such pilot');
    const [a, b] = [req.pilot!.uid, o.rows[0].uid].sort();
    const { rows } = await db.query('select sender, body, created_at from drone_dms where a = $1 and b = $2 order by id desc limit 100', [a, b]);
    res.json({ messages: rows.reverse().map((x) => ({ mine: x.sender === req.pilot!.uid, m: x.body, at: x.created_at })) });
  });

  r.use('/premium', premiumRoutes(db, auth('pilot')));

  return r;
}

const ATTEST = process.env.ATTEST_REQUIRED !== '0';

/** Live-attestation + uniqueness. Returns an error string, or null when the run is acceptable. */
async function attestation(db: Db, hub: Hub, p: Pilot, mapId: string, run: RunFile, inputs: QInput[], finishTick: number): Promise<string | null> {
  const digest = inputsDigest(inputs.slice(0, finishTick));
  // same pilot, same map, identical inputs = a re-upload. Different pilots may
  // legitimately produce identical inputs (e.g. a straight line held on W).
  const dup = await db.query('select 1 from drone_submissions where uid = $1 and map_id = $2 and laps = $3 and digest = $4 limit 1', [p.uid, mapId, run.laps, digest]);
  if (dup.rows.length) return 'you already submitted this exact run';
  let attemptId = `unattested-${rid(10)}`;
  if (ATTEST) {
    const a = hub.takeAttempt(run.attempt, p.uid, mapId, run.laps);
    if (typeof a === 'string') return a;
    const err = checkHeartbeats(a.hb, inputs, finishTick);
    if (err) return err;
    attemptId = a.id;
  }
  await db.query('insert into drone_submissions (attempt_id, uid, map_id, laps, digest, ms) values ($1,$2,$3,$4,$5,$6)', [attemptId, p.uid, mapId, run.laps, digest, Math.round(finishTick * 1000 / 120)]);
  return null;
}

async function upsertRun(db: Db, mapId: string, laps: number, p: Pilot, ms: number, lapTimes: number[], run: unknown) {
  const prev = await db.query('select id, ms from drone_runs where map_id = $1 and laps = $2 and uid = $3', [mapId, laps, p.uid]);
  if (prev.rows[0] && prev.rows[0].ms <= ms) return false;
  const id = prev.rows[0]?.id ?? rid(12);
  await db.query(
    `insert into drone_runs (id, map_id, laps, uid, player, ms, lap_times, mode, run) values ($1,$2,$3,$4,$5,$6,$7,$8,$9)
     on conflict (map_id, laps, uid) do update set ms = $6, lap_times = $7, mode = $8, run = $9, player = $5, hidden = false, created_at = now()`,
    [id, mapId, laps, p.uid, p.name, ms, JSON.stringify(lapTimes), (run as any).mode ?? 'arcade', JSON.stringify(run)]);
  return true;
}

async function setHidden(db: Db, kind: string, target: string, hidden: boolean) {
  if (kind === 'map') await db.query('update drone_maps set hidden = $2 where id = $1', [target, hidden]);
  else if (kind === 'run') await db.query('update drone_runs set hidden = $2 where id = $1', [target, hidden]);
  else if (kind === 'texture') await db.query('update drone_textures set hidden = $2 where id = $1', [target, hidden]);
  else if (kind === 'review') {
    const [mapId, uid] = target.split('|');
    const r = await db.query('update drone_reviews set hidden = $3 where map_id = $1 and uid = $2 and hidden <> $3 returning stars', [mapId, uid, hidden]);
    if (r.rows[0]) await db.query('update drone_maps set rating_sum = rating_sum + $2, rating_count = rating_count + $3 where id = $1', [mapId, hidden ? -r.rows[0].stars : r.rows[0].stars, hidden ? -1 : 1]);
  } else if (kind === 'pilot') await db.query('update drone_pilots set banned = $2 where name_lc = $1', [target.toLowerCase(), hidden]);
}
