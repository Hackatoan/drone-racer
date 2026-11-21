// Fully rebindable input. Every action takes up to 3 bindings from keyboard,
// mouse buttons, wheel, gamepad buttons (analog triggers included) or any
// gamepad axis. Keyboard players get analog-ish control via per-binding
// strength, a precision modifier, and optional ramp-up.
import { type Input } from '../../shared/physics.ts';
import { clamp } from '../../shared/math.ts';
import { emptyInput } from '../../shared/physics.ts';
import { BTN_BOOST, BTN_LEVEL, BTN_RESPAWN } from '../../shared/replay.ts';

export type Dev = 'key' | 'mouse' | 'wheel' | 'pbtn' | 'paxis';
export interface Binding { dev: Dev; code: string | number; dir?: 1 | -1; scale?: number }

export const ACTIONS = {
  // movement (analog)
  fwd: 'Forward', back: 'Backward', left: 'Strafe left', right: 'Strafe right', up: 'Up', down: 'Down',
  // look (rate, for keys/sticks — the mouse aims directly)
  lookUp: 'Look up', lookDown: 'Look down', lookLeft: 'Look left', lookRight: 'Look right',
  // buttons
  boost: 'Boost', level: 'Level flight (hold)', levelToggle: 'Level flight (toggle)', precision: 'Precision (hold)',
  fire: 'Fire blaster', alt: 'Fire railgun', respawn: 'Respawn at checkpoint', restart: 'Restart run',
  camera: 'Switch camera', pause: 'Pause / menu', scores: 'Scoreboard', chat: 'Chat',
  thrUp: 'Acro: throttle step up', thrDown: 'Acro: throttle step down',
} as const;
export type Action = keyof typeof ACTIONS;
export const ANALOG: Action[] = ['fwd', 'back', 'left', 'right', 'up', 'down', 'lookUp', 'lookDown', 'lookLeft', 'lookRight'];

export interface ActionOpts { deadzone: number; sens: number; curve: number; ramp: number }
export interface Bindings { map: Partial<Record<Action, Binding[]>>; opts: Partial<Record<Action, Partial<ActionOpts>>> }

const K = (code: string, scale?: number): Binding => ({ dev: 'key', code, ...(scale ? { scale } : {}) });
const M = (code: number): Binding => ({ dev: 'mouse', code });
const W = (dir: 1 | -1): Binding => ({ dev: 'wheel', code: 0, dir });
const PB = (code: number): Binding => ({ dev: 'pbtn', code });
const PA = (code: number, dir: 1 | -1): Binding => ({ dev: 'paxis', code, dir });

/** Gamepad bindings shared by every preset (Xbox layout, standard mapping). */
const PAD: Partial<Record<Action, Binding>> = {
  fwd: PA(1, -1), back: PA(1, 1), left: PA(0, -1), right: PA(0, 1), up: PB(7), down: PB(6),
  lookUp: PA(3, -1), lookDown: PA(3, 1), lookLeft: PA(2, -1), lookRight: PA(2, 1),
  boost: PB(4), fire: PB(5), alt: PB(3), respawn: PB(2), restart: PB(8), camera: PB(11), pause: PB(9), level: PB(10), precision: PB(1),
};

function preset(keys: Partial<Record<Action, Binding[]>>): Bindings {
  const map: Bindings['map'] = {};
  for (const a of Object.keys(ACTIONS) as Action[]) {
    const list = [...(keys[a] ?? [])];
    if (PAD[a]) list.push(PAD[a]!);
    map[a] = list.slice(0, 3);
  }
  return { map, opts: {} };
}

export const PRESETS: Record<string, { name: string; desc: string; mouseLook: boolean; make: () => Bindings }> = {
  wasd: {
    name: 'WASD + mouse', desc: 'Mouse aims, W flies where you look. Space/C up/down, Shift boost.', mouseLook: true,
    make: () => preset({
      fwd: [K('KeyW')], back: [K('KeyS')], left: [K('KeyA')], right: [K('KeyD')], up: [K('Space')], down: [K('KeyC')],
      boost: [K('ShiftLeft')], level: [K('KeyQ')], precision: [K('KeyX')], fire: [M(0)], alt: [M(2), K('KeyF')],
      respawn: [K('KeyR')], restart: [K('Backspace'), K('Delete')], camera: [K('KeyV')], pause: [K('Escape'), K('KeyP')],
      scores: [K('Tab')], chat: [K('Enter'), K('KeyT')], thrUp: [K('Equal')], thrDown: [K('Minus')], levelToggle: [K('KeyL')],
    }),
  },
  arrows: {
    name: 'Arrow keys + mouse', desc: 'Arrows move, right Shift/Ctrl up/down, mouse aims.', mouseLook: true,
    make: () => preset({
      fwd: [K('ArrowUp')], back: [K('ArrowDown')], left: [K('ArrowLeft')], right: [K('ArrowRight')], up: [K('ShiftRight'), K('PageUp')], down: [K('ControlRight'), K('PageDown')],
      boost: [K('Slash'), K('Numpad0')], level: [K('Period')], precision: [K('Comma')], fire: [M(0)], alt: [M(2)],
      respawn: [K('End')], restart: [K('Backspace')], camera: [K('Home')], pause: [K('Escape')], scores: [K('Tab')], chat: [K('Enter')],
      thrUp: [K('NumpadAdd')], thrDown: [K('NumpadSubtract')], levelToggle: [K('Insert')],
    }),
  },
  keyboard: {
    name: 'Keyboard only', desc: 'WASD moves, arrow keys look. Hold Shift+arrow for fine aim. No mouse needed.', mouseLook: false,
    make: () => {
      const b = preset({
        fwd: [K('KeyW')], back: [K('KeyS')], left: [K('KeyA')], right: [K('KeyD')], up: [K('Space')], down: [K('KeyC')],
        lookUp: [K('ArrowUp')], lookDown: [K('ArrowDown')], lookLeft: [K('ArrowLeft')], lookRight: [K('ArrowRight')],
        boost: [K('ShiftLeft')], level: [K('KeyQ')], precision: [K('ControlLeft'), K('KeyX')], fire: [K('KeyJ')], alt: [K('KeyK')],
        respawn: [K('KeyR')], restart: [K('Backspace')], camera: [K('KeyV')], pause: [K('Escape')], scores: [K('Tab')], chat: [K('Enter')],
        thrUp: [K('Equal')], thrDown: [K('Minus')], levelToggle: [K('KeyL')],
      });
      for (const a of ['lookLeft', 'lookRight', 'lookUp', 'lookDown'] as Action[]) b.opts[a] = { ramp: 180 };
      return b;
    },
  },
  mouse: {
    name: 'Mouse only', desc: 'Mouse aims, left button flies, right button boosts, wheel climbs/sinks, side buttons fire.', mouseLook: true,
    make: () => preset({
      fwd: [M(0)], back: [M(1)], up: [W(-1)], down: [W(1)], boost: [M(2)], fire: [M(4)], alt: [M(3)],
      respawn: [K('KeyR')], restart: [K('Backspace')], camera: [K('KeyV')], pause: [K('Escape')], scores: [K('Tab')], chat: [K('Enter')],
    }),
  },
  lefty: {
    name: 'Left-handed (IJKL)', desc: 'Right hand on IJKL, mouse in the left hand.', mouseLook: true,
    make: () => preset({
      fwd: [K('KeyI')], back: [K('KeyK')], left: [K('KeyJ')], right: [K('KeyL')], up: [K('KeyO')], down: [K('KeyU')],
      boost: [K('Space')], level: [K('KeyY')], precision: [K('KeyN')], fire: [M(0)], alt: [M(2)], respawn: [K('KeyP')], restart: [K('Backspace')],
      camera: [K('KeyH')], pause: [K('Escape')], scores: [K('Tab')], chat: [K('Enter')], thrUp: [K('BracketRight')], thrDown: [K('BracketLeft')],
    }),
  },
  pad: {
    name: 'Gamepad', desc: 'Left stick moves, right stick looks, RT/LT up/down, LB boost, RB fire.', mouseLook: false,
    make: () => preset({ pause: [K('Escape')], chat: [K('Enter')], scores: [K('Tab')] }),
  },
};

export const DEFAULT_OPTS: ActionOpts = { deadzone: 0.12, sens: 1, curve: 1.6, ramp: 0 };

export interface InputSettings {
  preset: string;
  bindings: Bindings;
  mouseSens: number; // radians per pixel ×1000
  invertY: boolean;
  lookRate: number; // rad/s for rate-look at full deflection
  precisionScale: number;
  acroRates: number;
}

export const defaultInputSettings = (): InputSettings => ({ preset: 'wasd', bindings: PRESETS.wasd.make(), mouseSens: 2.2, invertY: false, lookRate: 3.4, precisionScale: 0.4, acroRates: 1 });

export function describe(b: Binding | undefined): string {
  if (!b) return '—';
  const scale = b.scale && b.scale < 1 ? ` ${Math.round(b.scale * 100)}%` : '';
  switch (b.dev) {
    case 'key': return String(b.code).replace(/^Key/, '').replace(/^Digit/, '').replace(/^Arrow/, '↑').replace('↑Up', '↑').replace('↑Down', '↓').replace('↑Left', '←').replace('↑Right', '→') + scale;
    case 'mouse': return ['Mouse L', 'Mouse M', 'Mouse R', 'Mouse 4', 'Mouse 5'][Number(b.code)] ?? `Mouse ${b.code}`;
    case 'wheel': return b.dir === -1 ? 'Wheel up' : 'Wheel down';
    case 'pbtn': return ['Pad A', 'Pad B', 'Pad X', 'Pad Y', 'Pad LB', 'Pad RB', 'Pad LT', 'Pad RT', 'Pad Back', 'Pad Start', 'Pad L3', 'Pad R3', 'D-pad ↑', 'D-pad ↓', 'D-pad ←', 'D-pad →', 'Pad Home'][Number(b.code)] ?? `Pad btn ${b.code}`;
    case 'paxis': return `${['LS X', 'LS Y', 'RS X', 'RS Y'][Number(b.code)] ?? `Axis ${b.code}`} ${b.dir === 1 ? '+' : '−'}`;
  }
}

export class Controls {
  keys = new Map<string, number>(); // code -> pressed timestamp
  mouseBtns = new Map<number, number>();
  wheel = [0, 0]; // decaying impulses for up / down
  mdx = 0; mdy = 0;
  edges = new Set<Action>();
  private prevDown = new Set<Action>();
  levelToggled = false;
  thrLevel = 0;
  capture: ((b: Binding) => void) | null = null;
  private padPrev: number[] = [];
  enabled = true;
  usingPad = false;

  constructor(public s: InputSettings, private el: HTMLElement) {
    addEventListener('keydown', (e) => {
      if (this.capture) { e.preventDefault(); if (e.code !== 'Escape') this.capture({ dev: 'key', code: e.code }); else this.capture = null; return; }
      if (isTyping(e)) return;
      if (!this.keys.has(e.code)) this.keys.set(e.code, performance.now());
      if (this.enabled && ['Space', 'Tab', 'Backspace', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Slash', 'PageUp', 'PageDown'].includes(e.code)) e.preventDefault();
      this.usingPad = false;
    });
    addEventListener('keyup', (e) => this.keys.delete(e.code));
    addEventListener('blur', () => { this.keys.clear(); this.mouseBtns.clear(); });
    el.addEventListener('mousedown', (e) => {
      if (this.capture) { e.preventDefault(); this.capture({ dev: 'mouse', code: e.button }); return; }
      this.mouseBtns.set(e.button, performance.now());
    });
    addEventListener('mouseup', (e) => this.mouseBtns.delete(e.button));
    el.addEventListener('contextmenu', (e) => e.preventDefault());
    el.addEventListener('wheel', (e) => {
      if (this.capture) { this.capture({ dev: 'wheel', code: 0, dir: e.deltaY < 0 ? -1 : 1 }); return; }
      const i = e.deltaY < 0 ? 0 : 1;
      this.wheel[i] = Math.min(1, this.wheel[i] + 0.5);
    }, { passive: true });
    addEventListener('mousemove', (e) => {
      if (document.pointerLockElement === el) { this.mdx += e.movementX; this.mdy += e.movementY; }
    });
  }

  get mouseLook() { return PRESETS[this.s.preset]?.mouseLook ?? true; }

  private pads(): Gamepad | null {
    for (const p of navigator.getGamepads?.() ?? []) if (p && p.connected) return p;
    return null;
  }

  /** Raw 0..1 value of one binding. */
  private bindVal(b: Binding, pad: Gamepad | null, now: number, ramp: number): number {
    const sc = b.scale ?? 1;
    const held = (t: number | undefined) => t === undefined ? 0 : ramp > 0 ? Math.min(1, (now - t) / ramp) : 1;
    switch (b.dev) {
      case 'key': return held(this.keys.get(String(b.code))) * sc;
      case 'mouse': return held(this.mouseBtns.get(Number(b.code))) * sc;
      case 'wheel': return this.wheel[b.dir === -1 ? 0 : 1] * sc;
      case 'pbtn': return (pad?.buttons[Number(b.code)]?.value ?? 0) * sc;
      case 'paxis': return Math.max(0, (pad?.axes[Number(b.code)] ?? 0) * (b.dir ?? 1)) * sc;
    }
  }

  value(a: Action, pad: Gamepad | null, now: number): number {
    const o = { ...DEFAULT_OPTS, ...this.s.bindings.opts[a] };
    let best = 0;
    for (const b of this.s.bindings.map[a] ?? []) {
      let v = this.bindVal(b, pad, now, b.dev === 'key' || b.dev === 'mouse' ? o.ramp : 0);
      if (b.dev === 'paxis' || (b.dev === 'pbtn' && (b.code === 6 || b.code === 7))) {
        // analog: deadzone + response curve
        v = v <= o.deadzone ? 0 : Math.pow((v - o.deadzone) / (1 - o.deadzone), o.curve);
        if (v > 0) this.usingPad = true;
      }
      best = Math.max(best, v);
    }
    return clamp(best * o.sens, 0, 1);
  }

  down(a: Action, pad: Gamepad | null, now: number) { return this.value(a, pad, now) > 0.5; }

  /**
   * Sample everything once per rendered frame. Look angles are integrated by the caller
   * (they're absolute in arcade mode); returns deltas.
   */
  poll(dt: number, mode: 'arcade' | 'acro') {
    const now = performance.now();
    const pad = this.pads();
    const v = (a: Action) => this.value(a, pad, now);
    // edges for button actions
    this.edges.clear();
    for (const a of Object.keys(ACTIONS) as Action[]) {
      if (ANALOG.includes(a)) continue;
      const d = this.down(a, pad, now);
      if (d && !this.prevDown.has(a)) { this.edges.add(a); this.prevDown.add(a); }
      else if (!d) this.prevDown.delete(a);
    }
    if (this.edges.has('levelToggle')) this.levelToggled = !this.levelToggled;
    if (this.edges.has('thrUp')) this.thrLevel = Math.min(1, this.thrLevel + 0.1);
    if (this.edges.has('thrDown')) this.thrLevel = Math.max(0, this.thrLevel - 0.1);
    this.wheel[0] *= Math.pow(0.02, dt); this.wheel[1] *= Math.pow(0.02, dt);
    const prec = this.down('precision', pad, now) ? this.s.precisionScale : 1;
    const inp: Input = emptyInput();
    let dyaw = 0, dpitch = 0;
    const lx = v('lookRight') - v('lookLeft'), ly = v('lookUp') - v('lookDown');
    if (mode === 'arcade') {
      inp.mz = (v('fwd') - v('back')) * prec;
      inp.mx = (v('right') - v('left')) * prec;
      inp.my = (v('up') - v('down')) * prec;
      dyaw = -lx * this.s.lookRate * prec * dt;
      dpitch = ly * this.s.lookRate * 0.8 * prec * dt;
      if (this.mouseLook && document.pointerLockElement === this.el) {
        const k = this.s.mouseSens / 1000 * prec;
        dyaw -= this.mdx * k;
        dpitch -= this.mdy * k * (this.s.invertY ? -1 : 1);
      }
    } else {
      // Mode-2 acro: left stick throttle/yaw, right stick pitch/roll
      const thrAxis = pad ? clamp((-(pad.axes[1] ?? 0) + 1) / 2, 0, 1) : 0;
      const usingStick = pad && Math.abs(pad.axes[1] ?? 0) > 0.05;
      inp.my = usingStick ? thrAxis : clamp(this.thrLevel + (v('fwd') - v('back')) * 0.5, 0, 1);
      inp.ry = (v('right') - v('left')) * prec;
      inp.rp = -ly * prec;
      inp.rr = lx * prec;
    }
    this.mdx = this.mdy = 0;
    let buttons = 0;
    if (this.down('boost', pad, now)) buttons |= BTN_BOOST;
    if (this.down('level', pad, now) || this.levelToggled) buttons |= BTN_LEVEL;
    if (this.edges.has('respawn')) buttons |= BTN_RESPAWN;
    // pad edge detection for capture mode
    if (this.capture && pad) {
      pad.buttons.forEach((b, i) => { if (b.value > 0.6 && !(this.padPrev[i] > 0.6)) this.capture?.({ dev: 'pbtn', code: i }); });
      pad.axes.forEach((x, i) => { if (Math.abs(x) > 0.7 && !(Math.abs(this.padPrev[100 + i] ?? 0) > 0.7)) this.capture?.({ dev: 'paxis', code: i, dir: x > 0 ? 1 : -1 }); });
    }
    if (pad) { pad.buttons.forEach((b, i) => (this.padPrev[i] = b.value)); pad.axes.forEach((x, i) => (this.padPrev[100 + i] = x)); }
    return { inp, dyaw, dpitch, buttons, fire: this.down('fire', pad, now), alt: this.down('alt', pad, now) };
  }

  pressed(a: Action) { return this.edges.has(a); }
}

const isTyping = (e: Event) => {
  const t = e.target as HTMLElement;
  return t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.tagName === 'SELECT' || t.isContentEditable);
};
