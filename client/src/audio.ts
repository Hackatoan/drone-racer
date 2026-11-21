// Procedural Web Audio: motor whine, wind by speed, and one-shot effects.
import { settings } from './state.ts';

let ctx: AudioContext | null = null;
let master: GainNode;
let motor: OscillatorNode, motor2: OscillatorNode, motorGain: GainNode, motorFilter: BiquadFilterNode;
let windGain: GainNode, windFilter: BiquadFilterNode;
let noiseBuf: AudioBuffer;

export function initAudio() {
  if (ctx) { if (ctx.state === 'suspended') ctx.resume(); return; }
  ctx = new AudioContext();
  master = ctx.createGain();
  master.gain.value = settings.volume;
  master.connect(ctx.destination);
  noiseBuf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
  const d = noiseBuf.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;

  motorFilter = ctx.createBiquadFilter();
  motorFilter.type = 'lowpass';
  motorFilter.frequency.value = 1400;
  motorGain = ctx.createGain();
  motorGain.gain.value = 0;
  motor = ctx.createOscillator(); motor.type = 'sawtooth';
  motor2 = ctx.createOscillator(); motor2.type = 'square';
  motor.connect(motorFilter); motor2.connect(motorFilter);
  motorFilter.connect(motorGain).connect(master);
  motor.start(); motor2.start();

  const wind = ctx.createBufferSource();
  wind.buffer = noiseBuf; wind.loop = true;
  windFilter = ctx.createBiquadFilter();
  windFilter.type = 'bandpass'; windFilter.Q.value = 0.6;
  windGain = ctx.createGain(); windGain.gain.value = 0;
  wind.connect(windFilter).connect(windGain).connect(master);
  wind.start();
}

export function setVolume(v: number) { if (ctx) master.gain.value = v; }

/** Call every frame. throttle 0..1, speed m/s. */
export function engine(throttle: number, speed: number, active: boolean) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const f = 140 + throttle * 220 + speed * 3;
  motor.frequency.setTargetAtTime(f, t, 0.05);
  motor2.frequency.setTargetAtTime(f * 1.503, t, 0.05);
  motorGain.gain.setTargetAtTime(active ? 0.035 + throttle * 0.04 : 0, t, 0.08);
  windFilter.frequency.setTargetAtTime(300 + speed * 25, t, 0.1);
  windGain.gain.setTargetAtTime(active ? Math.min(0.25, speed * speed * 0.00006) : 0, t, 0.1);
}

function tone(freq: number, dur: number, type: OscillatorType = 'sine', vol = 0.2, slide = 0) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const o = ctx.createOscillator(); o.type = type; o.frequency.setValueAtTime(freq, t);
  if (slide) o.frequency.exponentialRampToValueAtTime(Math.max(20, freq + slide), t + dur);
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  o.connect(g).connect(master); o.start(t); o.stop(t + dur + 0.02);
}
function noise(dur: number, freq: number, vol = 0.3) {
  if (!ctx) return;
  const t = ctx.currentTime;
  const s = ctx.createBufferSource(); s.buffer = noiseBuf;
  const fl = ctx.createBiquadFilter(); fl.type = 'lowpass'; fl.frequency.value = freq;
  const g = ctx.createGain(); g.gain.setValueAtTime(vol, t); g.gain.exponentialRampToValueAtTime(0.0001, t + dur);
  s.connect(fl).connect(g).connect(master); s.start(t); s.stop(t + dur);
}

export const sfx = {
  checkpoint: (ahead: boolean | null) => { tone(ahead === false ? 660 : 880, 0.12, 'triangle', 0.2); setTimeout(() => tone(ahead === false ? 520 : 1320, 0.16, 'triangle', 0.18), 70); },
  lap: () => [660, 880, 1100].forEach((f, i) => setTimeout(() => tone(f, 0.18, 'triangle', 0.2), i * 90)),
  finish: () => [523, 659, 784, 1046].forEach((f, i) => setTimeout(() => tone(f, 0.3, 'triangle', 0.22), i * 110)),
  crash: () => { noise(0.45, 900, 0.5); tone(90, 0.4, 'sine', 0.4, -50); },
  bump: () => noise(0.12, 1500, 0.15),
  beep: (hi: boolean) => tone(hi ? 1046 : 523, hi ? 0.4 : 0.18, 'square', 0.12),
  shot: () => { tone(1500, 0.07, 'square', 0.07, -900); },
  rail: () => { tone(300, 0.5, 'sawtooth', 0.15, 1800); noise(0.3, 4000, 0.12); },
  hit: () => tone(1800, 0.05, 'square', 0.12),
  hurt: () => noise(0.15, 600, 0.3),
  kill: () => [880, 1320].forEach((f, i) => setTimeout(() => tone(f, 0.12, 'square', 0.1), i * 60)),
  ui: () => tone(700, 0.05, 'triangle', 0.08),
};
