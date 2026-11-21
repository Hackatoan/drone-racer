// One SQL code path: real Postgres in production (DATABASE_URL), in-process
// PGlite (same dialect) for local dev, persisted under ./data.
import pg from 'pg';

export interface Db {
  query<T = any>(sql: string, params?: unknown[]): Promise<{ rows: T[] }>;
  kind: 'pg' | 'pglite';
}

const SCHEMA = `
create table if not exists drone_pilots (
  uid text primary key, name text not null, name_lc text unique not null,
  premium boolean not null default false, banned boolean not null default false,
  created_at timestamptz not null default now());
create table if not exists drone_maps (
  id text primary key, name text not null, author text not null, author_uid text not null,
  descr text not null default '', data jsonb not null, hash text not null, thumb text,
  laps int not null, checkpoints int not null, author_ms int not null, author_run jsonb not null,
  plays int not null default 0, rating_sum int not null default 0, rating_count int not null default 0,
  hidden boolean not null default false, created_at timestamptz not null default now());
create index if not exists drone_maps_created on drone_maps (created_at desc);
create table if not exists drone_runs (
  id text primary key, map_id text not null, laps int not null, uid text not null, player text not null,
  ms int not null, lap_times jsonb not null, mode text not null, run jsonb not null,
  hidden boolean not null default false, created_at timestamptz not null default now(),
  unique (map_id, laps, uid));
create index if not exists drone_runs_board on drone_runs (map_id, laps, ms);
create table if not exists drone_reviews (
  map_id text not null, uid text not null, player text not null, stars int not null, body text not null default '',
  hidden boolean not null default false, created_at timestamptz not null default now(), primary key (map_id, uid));
create table if not exists drone_reports (
  id serial primary key, kind text not null, target text not null, reason text not null,
  reporter_uid text not null, status text not null default 'open', created_at timestamptz not null default now(),
  unique (kind, target, reporter_uid));
create table if not exists drone_textures (
  id text primary key, uid text not null, name text not null, mime text not null, bytes bytea not null,
  purpose text not null default 'map', hidden boolean not null default false, created_at timestamptz not null default now());
create table if not exists drone_stats (
  uid text primary key, player text not null,
  races int not null default 0, race_wins int not null default 0,
  kills int not null default 0, deaths int not null default 0, pvp_matches int not null default 0, pvp_wins int not null default 0,
  tourneys int not null default 0, tourney_wins int not null default 0, tourney_points int not null default 0);
create table if not exists drone_friends (
  a text not null, b text not null, status text not null, created_at timestamptz not null default now(), primary key (a, b));
create table if not exists drone_dms (
  id serial primary key, a text not null, b text not null, sender text not null, body text not null,
  created_at timestamptz not null default now());
create index if not exists drone_dms_pair on drone_dms (a, b, id desc);
create table if not exists drone_tourneys (id text primary key, map_id text not null, started_at timestamptz not null, data jsonb not null);
create table if not exists drone_submissions (
  attempt_id text primary key, uid text not null, map_id text not null, laps int not null, digest text not null, ms int not null,
  created_at timestamptz not null default now());
create index if not exists drone_submissions_dedupe on drone_submissions (uid, map_id, laps, digest);
create table if not exists drone_payments (session_id text primary key, uid text not null, amount int not null, created_at timestamptz not null default now());
`;

export async function openDb(): Promise<Db> {
  const url = process.env.DATABASE_URL;
  let db: Db;
  if (url) {
    const pool = new pg.Pool({ connectionString: url, max: 5 });
    db = { kind: 'pg', query: (sql, params) => pool.query(sql, params as any[]) as any };
  } else {
    const { PGlite } = await import('@electric-sql/pglite');
    const { mkdirSync } = await import('node:fs');
    const dir = process.env.PGLITE_DIR ?? './data/pglite';
    mkdirSync(dir, { recursive: true });
    const lite = new PGlite(dir);
    db = { kind: 'pglite', query: (sql, params) => lite.query(sql, params as any[]) as any };
  }
  for (const stmt of SCHEMA.split(';').map((s) => s.trim()).filter(Boolean)) await db.query(stmt);
  return db;
}

/** games-hub aggregate board (shared `leaderboards` table) — only exists on the production DB. */
export async function recordHub(db: Db, player: string, result: 'win' | 'loss') {
  if (db.kind !== 'pg') return;
  try {
    await db.query(
      `insert into leaderboards (game, player, wins, losses, draws, games_played, updated_at)
       values ('drone', $1, $2, $3, 0, 1, now())
       on conflict (game, player) do update set wins = leaderboards.wins + $2, losses = leaderboards.losses + $3,
         games_played = leaderboards.games_played + 1, updated_at = now()`,
      [player, result === 'win' ? 1 : 0, result === 'loss' ? 1 : 0],
    );
  } catch { /* hub board is best-effort */ }
}
