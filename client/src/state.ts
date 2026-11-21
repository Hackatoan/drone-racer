// App-wide state: settings (persisted), identity, API + socket access.
import { defaultInputSettings, type InputSettings, PRESETS } from './input.ts';
import { defaultSkin, sanitizeSkin, type Skin } from '../../shared/skins.ts';
import type { FlightMode } from '../../shared/physics.ts';
import type { RunFile } from '../../shared/replay.ts';

export interface Settings {
  flight: FlightMode;
  camera: 'fpv' | 'chase';
  fov: number;
  fpvTilt: number; // degrees, camera uptilt in acro
  fovKick: boolean;
  shake: boolean;
  quality: 'low' | 'med' | 'high';
  textures: 'all' | 'builtin' | 'none';
  volume: number;
  showFps: boolean;
  input: InputSettings;
  skin: Skin;
  ghosts: { pb: boolean; wr: boolean; author: boolean };
  splitRef: 'pb' | 'wr' | 'author';
  nameplates: boolean;
}

const KEY = 'drone.settings.v1';
function load(): Settings {
  const d: Settings = {
    flight: 'arcade', camera: 'fpv', fov: 92, fpvTilt: 25, fovKick: true, shake: true, quality: 'high', textures: 'all', volume: 0.6, showFps: false,
    input: defaultInputSettings(), skin: defaultSkin(), ghosts: { pb: true, wr: false, author: false }, splitRef: 'pb', nameplates: true,
  };
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? 'null');
    if (raw && typeof raw === 'object') {
      const s = { ...d, ...raw, input: { ...d.input, ...raw.input }, ghosts: { ...d.ghosts, ...raw.ghosts } };
      s.skin = sanitizeSkin(raw.skin, true);
      if (!s.input.bindings?.map || !PRESETS[s.input.preset]) s.input = d.input;
      return s;
    }
  } catch { /* storage blocked */ }
  return d;
}

export const settings: Settings = load();
export function saveSettings() {
  try { localStorage.setItem(KEY, JSON.stringify(settings)); } catch { /* ignore */ }
}

export const me = {
  uid: null as string | null,
  name: null as string | null, // pilot name (signed in) or guest name from server
  premium: false,
  admin: false,
  signedIn: false,
  token: null as string | null,
};

// ------------------------------------------------------------ local PBs (run files) per map+laps
const PBKEY = 'drone.pb.v1';
export function localPb(mapId: string, laps: number, hash: string): RunFile | null {
  try {
    const all = JSON.parse(localStorage.getItem(PBKEY) ?? '{}');
    const r = all[`${mapId}|${laps}`];
    return r && r.mapHash === hash ? r : null;
  } catch { return null; }
}
export function saveLocalPb(r: RunFile) {
  try {
    const all = JSON.parse(localStorage.getItem(PBKEY) ?? '{}');
    all[`${r.mapId}|${r.laps}`] = r;
    localStorage.setItem(PBKEY, JSON.stringify(all));
  } catch { /* quota: PBs are a convenience */ }
}
