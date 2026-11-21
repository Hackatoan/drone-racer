// Run-file packing (gzip+base64 via CompressionStream) and replay helpers.
import type { World } from '../../shared/collide.ts';
import { type QInput, type RunFile, encodeInputs, decodeInputs, RunSim } from '../../shared/replay.ts';
import type { FlightMode } from '../../shared/physics.ts';

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const s = new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip'));
  return new Uint8Array(await new Response(s).arrayBuffer());
}
const toB64 = (b: Uint8Array) => { let s = ''; for (let i = 0; i < b.length; i += 0x8000) s += String.fromCharCode(...b.subarray(i, i + 0x8000)); return btoa(s); };
const fromB64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export async function packInputs(inputs: QInput[]) { return toB64(await gzip(encodeInputs(inputs))); }
export async function unpackInputs(run: RunFile): Promise<QInput[]> { return decodeInputs(await gunzip(fromB64(run.data))); }

export interface Replay { inputs: QInput[]; run: RunFile; sim: RunSim; splits: number[]; totalMs: number | null }

/** Simulate a run fully once to get its split times (every line crossing, in ms since the start). */
export function computeSplits(world: World, run: RunFile, inputs: QInput[]): { splits: number[]; totalMs: number | null } {
  const sim = new RunSim(world, { mode: run.mode as FlightMode, rates: run.rates, laps: run.laps });
  const splits: number[] = [];
  for (const q of inputs) {
    for (const e of sim.step(q)) {
      if (e.e === 'checkpoint' || e.e === 'lap') splits.push(e.t - sim.progress!.startT);
    }
    if (sim.finished) return { splits, totalMs: sim.progress!.totalMs };
  }
  return { splits, totalMs: null };
}

export async function loadReplay(world: World, run: RunFile): Promise<Replay> {
  const inputs = await unpackInputs(run);
  const { splits, totalMs } = computeSplits(world, run, inputs);
  return { inputs, run, sim: new RunSim(world, { mode: run.mode as FlightMode, rates: run.rates, laps: run.laps }), splits, totalMs };
}

export function download(name: string, data: unknown) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([JSON.stringify(data)], { type: 'application/json' }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}

export function pickFile(accept: string): Promise<string | null> {
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = accept;
    i.onchange = () => { const f = i.files?.[0]; if (!f) return res(null); f.text().then(res, () => res(null)); };
    i.click();
  });
}
