import { me } from './state.ts';
import { getToken } from './auth.ts';
import type { MapData } from '../../shared/map.ts';
import type { RunFile } from '../../shared/replay.ts';

export interface MapMeta {
  id: string; name: string; author: string; desc: string; laps: number; checkpoints: number; authorMs: number;
  plays: number; rating: number | null; ratings: number; thumb: string | null; official: boolean; created: string; sky: string;
}
export interface LoadedMap { id: string; meta: MapMeta | null; map: MapData; hash: string }

export async function api<T = any>(path: string, opts: { method?: string; body?: unknown } = {}): Promise<T> {
  const headers: Record<string, string> = {};
  const tok = await getToken();
  if (tok) headers.Authorization = `Bearer ${tok}`;
  if (opts.body !== undefined) headers['Content-Type'] = 'application/json';
  const r = await fetch(`/api${path}`, { method: opts.method ?? (opts.body !== undefined ? 'POST' : 'GET'), headers, body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error ?? `HTTP ${r.status}`);
  return j as T;
}

const mapCache = new Map<string, LoadedMap>();
export async function loadMap(id: string): Promise<LoadedMap> {
  const c = mapCache.get(id);
  if (c) return c;
  const m = await api<LoadedMap>(`/maps/${encodeURIComponent(id)}`);
  mapCache.set(id, m);
  return m;
}

export const getRun = (id: string) => api<RunFile>(`/runs/${encodeURIComponent(id)}`);
export const getAuthorRun = (mapId: string) => api<RunFile>(`/maps/${encodeURIComponent(mapId)}/author-run`);

export interface BoardRow { rank: number; id: string; player: string; ms: number; lapTimes: number[]; mode: string; at: string }
export const getBoard = (mapId: string, laps: number) => api<{ runs: BoardRow[]; laps: { laps: number; n: number }[] }>(`/runs?map=${encodeURIComponent(mapId)}&laps=${laps}`);

export function medals(authorMs: number) {
  return { author: authorMs, gold: Math.round(authorMs * 1.08), silver: Math.round(authorMs * 1.22), bronze: Math.round(authorMs * 1.5) };
}
export function medalFor(ms: number, authorMs: number): 'author' | 'gold' | 'silver' | 'bronze' | null {
  const m = medals(authorMs);
  return ms <= m.author ? 'author' : ms <= m.gold ? 'gold' : ms <= m.silver ? 'silver' : ms <= m.bronze ? 'bronze' : null;
}

void me;
