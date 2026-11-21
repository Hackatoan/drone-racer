// Map resolution (official / community / arena) with a small World cache, and
// run-file decoding + authoritative replay.
import { gunzipSync } from 'node:zlib';
import type { Db } from './db.ts';
import { type MapData, sanitizeMap } from '../shared/map.ts';
import { type World, buildWorld } from '../shared/collide.ts';
import { OFFICIAL, officialMap, autopilot, generateArena } from '../shared/mapgen.ts';
import { type RunFile, type QInput, decodeInputs, encodeInputs, replayRun, mapHash, MAX_TICKS } from '../shared/replay.ts';
import { gzipSync } from 'node:zlib';

export interface MapMeta {
  id: string;
  name: string;
  author: string;
  desc: string;
  laps: number;
  checkpoints: number;
  authorMs: number;
  plays: number;
  rating: number | null;
  ratings: number;
  thumb: string | null;
  official: boolean;
  created: string;
  sky: string;
}

interface Official { meta: MapMeta; map: MapData; hash: string; authorRun: RunFile }
const officials = new Map<string, Official>();

export function initOfficial() {
  for (const t of OFFICIAL) {
    const map = officialMap(t.slug)!;
    const world = buildWorld(map);
    const inputs = autopilot(world, map.laps);
    if (!inputs) { console.error(`[maps] official ${t.slug} not finishable — skipped`); continue; }
    const res = replayRun(buildWorld(map), { mode: 'arcade', rates: 1, laps: map.laps }, inputs);
    const id = `o:${t.slug}`;
    const hash = mapHash(map);
    const authorRun = makeRunFile(id, map, hash, 'Autopilot', inputs, res.totalMs!, res.lapTimes!);
    officials.set(id, {
      map, hash, authorRun,
      meta: { id, name: map.name, author: 'Hackatoa', desc: map.desc, laps: map.laps, checkpoints: map.checkpoints.length, authorMs: res.totalMs!, plays: 0, rating: null, ratings: 0, thumb: null, official: true, created: '2026-11-20', sky: map.sky },
    });
  }
  console.log(`[maps] ${officials.size} official maps ready`);
}

export const officialList = () => [...officials.values()].map((o) => o.meta);

export function makeRunFile(mapId: string, map: MapData, hash: string, player: string, inputs: QInput[], ms: number, lapTimes: number[]): RunFile {
  return {
    kind: 'drone-run', v: 1, mapId, mapHash: hash, mapName: map.name, laps: map.laps, mode: 'arcade', rates: 1, player,
    ticks: inputs.length, claimedMs: ms, lapTimes, date: new Date().toISOString(),
    data: gzipSync(encodeInputs(inputs)).toString('base64'),
  };
}

// --------------------------------------------------------------- lookup

export interface Resolved { id: string; map: MapData; hash: string; meta: MapMeta | null; authorRun: RunFile | null }

const worldCache = new Map<string, World>();
export function worldFor(id: string, map: MapData): World {
  let w = worldCache.get(id);
  if (!w) {
    w = buildWorld(map);
    worldCache.set(id, w);
    if (worldCache.size > 24) worldCache.delete(worldCache.keys().next().value!);
  }
  return w;
}

export async function resolveMap(db: Db, id: string): Promise<Resolved | null> {
  if (id.startsWith('o:')) {
    const o = officials.get(id);
    return o ? { id, map: o.map, hash: o.hash, meta: o.meta, authorRun: o.authorRun } : null;
  }
  if (id.startsWith('pvp:')) {
    const seed = Number(id.slice(4));
    if (!Number.isInteger(seed) || seed < 0) return null;
    const map = generateArena(seed);
    return { id, map, hash: mapHash(map), meta: null, authorRun: null };
  }
  if (id.startsWith('c:')) {
    const { rows } = await db.query('select * from drone_maps where id = $1 and not hidden', [id]);
    const r = rows[0];
    if (!r) return null;
    const map = sanitizeMap(r.data);
    return { id, map, hash: r.hash, meta: rowMeta(r), authorRun: r.author_run };
  }
  return null;
}

export function rowMeta(r: any): MapMeta {
  return {
    id: r.id, name: r.name, author: r.author, desc: r.descr, laps: r.laps, checkpoints: r.checkpoints, authorMs: r.author_ms,
    plays: r.plays, rating: r.rating_count ? r.rating_sum / r.rating_count : null, ratings: r.rating_count, thumb: r.thumb,
    official: false, created: new Date(r.created_at).toISOString(), sky: r.data?.sky ?? 'day',
  };
}

// --------------------------------------------------------------- runs

export interface Verified { ok: true; ms: number; lapTimes: number[]; inputs: QInput[]; ticks: number }

export function parseRunFile(raw: any): RunFile | null {
  if (!raw || raw.kind !== 'drone-run' || raw.v !== 1) return null;
  if (typeof raw.mapId !== 'string' || typeof raw.data !== 'string' || raw.data.length > 3_000_000) return null;
  if (!Number.isInteger(raw.laps) || raw.laps < 1 || raw.laps > 10) return null;
  if (raw.mode !== 'arcade' && raw.mode !== 'acro') return null;
  return raw as RunFile;
}

/** Decode and re-simulate. The returned time is the server's, never the client's claim. */
export function verifyRun(map: MapData, world: World, hash: string, run: RunFile): Verified | { ok: false; reason: string } {
  if (run.mapHash !== hash) return { ok: false, reason: 'run was flown on a different version of this map' };
  let inputs: QInput[];
  try {
    const bytes = gunzipSync(Buffer.from(run.data, 'base64'), { maxOutputLength: 4 * MAX_TICKS });
    inputs = decodeInputs(new Uint8Array(bytes));
  } catch (e) {
    return { ok: false, reason: `unreadable run (${(e as Error).message})` };
  }
  const rates = typeof run.rates === 'number' ? Math.max(0.5, Math.min(1.5, Math.round(run.rates * 100) / 100)) : 1;
  const res = replayRun(world, { mode: run.mode, rates, laps: run.laps }, inputs);
  if (!res.ok) return { ok: false, reason: res.reason ?? 'invalid' };
  void map;
  return { ok: true, ms: res.totalMs!, lapTimes: res.lapTimes!, inputs: inputs.slice(0, res.ticks), ticks: res.ticks! };
}
