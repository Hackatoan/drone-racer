// Drone cosmetics. Everything here is free; `tex` (an uploaded skin texture)
// is accepted only for players the server marks as entitled — the hook for a
// future paid custom-skin feature.
export const FRAMES = ['racer', 'whoop', 'heavy'] as const;
export const DECALS = ['none', 'stripes', 'carbon', 'camo', 'flames', 'checker', 'hex', 'splat'] as const;
export type Frame = (typeof FRAMES)[number];
export type Decal = (typeof DECALS)[number];

export interface Skin {
  frame: Frame;
  body: string;
  accent: string;
  props: string;
  led: string;
  decal: Decal;
  tex?: string; // u:<id>, premium only
}

export const defaultSkin = (): Skin => ({ frame: 'racer', body: '#1d2230', accent: '#ff7a1a', props: '#e8e8e8', led: '#29d3ff', decal: 'stripes' });

const hex = (x: unknown, d: string) => (typeof x === 'string' && /^#[0-9a-f]{6}$/i.test(x) ? x.toLowerCase() : d);

export function sanitizeSkin(raw: any, allowCustomTexture = false): Skin {
  const d = defaultSkin();
  if (!raw || typeof raw !== 'object') return d;
  const s: Skin = {
    frame: FRAMES.includes(raw.frame) ? raw.frame : d.frame,
    body: hex(raw.body, d.body),
    accent: hex(raw.accent, d.accent),
    props: hex(raw.props, d.props),
    led: hex(raw.led, d.led),
    decal: DECALS.includes(raw.decal) ? raw.decal : d.decal,
  };
  if (allowCustomTexture && typeof raw.tex === 'string' && /^u:[a-z0-9]{10,24}$/.test(raw.tex)) s.tex = raw.tex;
  return s;
}
