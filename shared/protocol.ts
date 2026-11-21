// WebSocket message shapes + shared constants for online play.
import type { V3, Q4 } from './math.ts';
import type { Skin } from './skins.ts';

/** tt = shared time trial: everyone flies their own deterministic run, others shown as live ghosts. */
export type RoomMode = 'race' | 'freeroam' | 'pvp' | 'ko' | 'tt';
export type TeamSize = 0 | 2 | 3 | 4; // 0 = free-for-all
export type Phase = 'lobby' | 'countdown' | 'running' | 'results';

export const NET_HZ = 20;
export const MAX_ROOM = 8;
export const COUNTDOWN_MS = 4000;
export const RESULTS_MS = 12000;
export const PVP_MATCH_MS = 5 * 60 * 1000;
export const PVP_KILL_LIMIT = 20;
export const PVP_RESPAWN_MS = 3000;
export const SPAWN_PROTECT_MS = 2000;
export const MAX_HP = 100;

export interface Weapon { name: string; dmg: number; cooldownMs: number; range: number; spread: number }
export const WEAPONS: Weapon[] = [
  { name: 'Blaster', dmg: 9, cooldownMs: 110, range: 260, spread: 0.012 },
  { name: 'Railgun', dmg: 55, cooldownMs: 1600, range: 600, spread: 0 },
];

export interface RoomInfo {
  id: string;
  mode: RoomMode;
  mapId: string;
  mapName: string;
  laps: number;
  collide: boolean;
  max: number;
  priv: boolean;
  host: string;
  phase: Phase;
  players: number;
  seed?: number; // pvp arena seed
  teamSize: TeamSize;
}

export interface PlayerInfo { id: string; name: string; skin: Skin; ready: boolean; ping: number; team: number; guest: boolean }

export interface CreateOpts { mode: RoomMode; mapId: string; laps: number; collide: boolean; priv: boolean; max: number; teamSize: TeamSize }

export type C2S =
  | { t: 'hello'; token: string | null; skin: Skin }
  | { t: 'list' }
  | { t: 'create'; opts: CreateOpts }
  | { t: 'join'; id: string }
  | { t: 'quick'; mode: RoomMode; teamSize?: TeamSize }
  | { t: 'leave' }
  | { t: 's'; p: V3; q: Q4; v: V3; yaw: number; pitch: number }
  | { t: 'ready'; v: boolean }
  | { t: 'start' }
  | { t: 'settings'; opts: Partial<CreateOpts> }
  | { t: 'respawn' }
  | { t: 'fire'; w: number; o: V3; d: V3 }
  | { t: 'chat'; m: string }
  | { t: 'ping'; c: number }
  | { t: 'tqueue'; v: boolean }
  | { t: 'friend'; op: 'add' | 'accept' | 'decline' | 'remove'; name: string }
  | { t: 'dm'; to: string; m: string }
  | { t: 'invite'; to: string }
  | { t: 'activity'; a: string }
  | { t: 'tt'; e: 'finish'; ms: number }
  | { t: 'att'; op: 'start'; mapId: string; laps: number; nonce: number }
  | { t: 'att'; op: 'hb'; id: string; tick: number; h: number };

/** Snapshot row: id, x,y,z, qx,qy,qz,qw, vx,vy,vz, flags (1 = dead, 2 = protected) */
export type SnapRow = [string, number, number, number, number, number, number, number, number, number, number, number];

export interface RaceStanding { id: string; name: string; lap: number; cp: number; finishMs: number | null; bestLap: number | null }
export interface PvpScore { id: string; name: string; kills: number; deaths: number; hp: number; team: number }

export type S2C =
  | { t: 'welcome'; id: string; name: string; uid: string | null; premium: boolean; admin: boolean }
  | { t: 'rooms'; list: RoomInfo[] }
  | { t: 'room'; room: RoomInfo; players: PlayerInfo[] }
  | { t: 'left' }
  | { t: 'snap'; ts: number; ps: SnapRow[] }
  | { t: 'phase'; phase: Phase; at: number; endsAt?: number; seed?: number }
  | { t: 'grid'; slots: Record<string, number> }
  | { t: 'race'; standings: RaceStanding[] }
  | { t: 'pvp'; scores: PvpScore[]; endsAt: number; teams: [number, number] | null }
  | { t: 'shot'; id: string; w: number; o: V3; e: V3; hit: string | null }
  | { t: 'dmg'; id: string; hp: number; by: string }
  | { t: 'kill'; killer: string; victim: string; w: number }
  | { t: 'spawn'; id: string; p: V3; r: number }
  | { t: 'chat'; from: string; m: string }
  | { t: 'err'; m: string }
  | { t: 'pong'; c: number; s: number }
  | { t: 'online'; n: number }
  | { t: 'tourney'; state: TourneyState }
  | { t: 'ko'; ko: KoState }
  | { t: 'friends'; list: FriendInfo[]; incoming: string[]; outgoing: string[] }
  | { t: 'dm'; from: string; to: string; m: string; at: number }
  | { t: 'invite'; from: string; room: RoomInfo }
  | { t: 'notice'; m: string }
  | { t: 'att'; nonce: number; id: string | null; err?: string }
  | { t: 'tt'; standings: { id: string; name: string; best: number | null; runs: number }[] };

export interface FriendInfo { name: string; online: boolean; activity: string | null; room: string | null }

// ---------------------------------------------------------------- tournaments

export type TourneyPhase = 'idle' | 'qualifying' | 'knockout' | 'done';
export interface TourneyState {
  id: string | null;
  phase: TourneyPhase;
  nextAt: number; // next scheduled start (ms epoch)
  endsAt: number | null; // end of the current phase
  mapId: string | null;
  mapName: string | null;
  laps: number; // qualifier laps
  queued: string[]; // pilots queued for the next tournament
  online: number;
  qualifiers: { name: string; ms: number }[];
  divisions: { div: number; room: string; players: string[]; winner: string | null }[];
  minPlayers: number;
}
export interface KoState {
  div: number;
  round: number;
  alive: string[]; // player names
  eliminated: { name: string; round: number }[];
  lastRound: { name: string; ms: number | null }[];
  winner: string | null;
}
export const KO_ROUND_LAPS = 1;
export const KO_ROUND_GRACE_MS = 25000;

/** Map ids: `o:<slug>` official, `c:<id>` community, `pvp:<seed>` generated arena. */
export const isPvpMap = (id: string) => id.startsWith('pvp:');
