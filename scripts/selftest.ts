// Core sanity checks: every official track is finishable by the autopilot,
// replays reproduce the exact time, and run encoding round-trips.
import { OFFICIAL, officialMap, autopilot, generateArena } from '../shared/mapgen.ts';
import { buildWorld } from '../shared/collide.ts';
import { replayRun, encodeInputs, decodeInputs, mapHash, checkHeartbeats, hashStep, HASH_SEED, HB_EVERY_TICKS, TICK_MS, inputsDigest } from '../shared/replay.ts';
import { dsin, dcos, datan2, dexp } from '../shared/dmath.ts';

let fail = 0;
const check = (ok: boolean, msg: string) => { console.log(`${ok ? 'ok  ' : 'FAIL'} ${msg}`); if (!ok) fail++; };

// dmath accuracy vs the platform (only accuracy here — determinism is by construction)
let worst = 0;
for (let x = -20; x < 20; x += 0.0137) {
  worst = Math.max(worst, Math.abs(dsin(x) - Math.sin(x)), Math.abs(dcos(x) - Math.cos(x)), Math.abs(datan2(x, 1.3) - Math.atan2(x, 1.3)));
}
for (let x = -10; x < 3; x += 0.01) worst = Math.max(worst, Math.abs(dexp(x) - Math.exp(x)) / Math.exp(x));
check(worst < 1e-12, `dmath max error ${worst.toExponential(2)}`);

for (const t of OFFICIAL) {
  const map = officialMap(t.slug)!;
  const world = buildWorld(map);
  const t0 = performance.now();
  const inputs = autopilot(world, map.laps);
  if (!inputs) { check(false, `${t.slug}: autopilot did not finish`); continue; }
  const bytes = encodeInputs(inputs);
  const back = decodeInputs(bytes);
  const same = back.length === inputs.length && back.every((q, i) => JSON.stringify(q) === JSON.stringify(inputs[i]));
  const r1 = replayRun(buildWorld(map), { mode: 'arcade', rates: 1, laps: map.laps }, back);
  const r2 = replayRun(buildWorld(map), { mode: 'arcade', rates: 1, laps: map.laps }, back);
  const ms = performance.now() - t0;
  check(same, `${t.slug}: encode round-trip (${inputs.length} ticks → ${bytes.length} bytes)`);
  check(r1.ok && r2.ok && r1.totalMs === r2.totalMs, `${t.slug}: ${map.laps} laps, ${map.checkpoints.length} cps, author ${(r1.totalMs! / 1000).toFixed(3)}s laps=${r1.lapTimes?.map((x) => (x / 1000).toFixed(2)).join('/')} hash ${mapHash(map)} [${ms.toFixed(0)}ms]`);
}
const a = generateArena(42), b = generateArena(42);
check(JSON.stringify(a) === JSON.stringify(b) && a.spawns.length === 12, `arena generation is deterministic (${a.objects.length} objects)`);

// attestation: heartbeats every 0.5 s of sim time, wall clock from a speed profile
{
  const map = officialMap('alpine')!;
  const inputs = autopilot(buildWorld(map), map.laps)!;
  const beats = (speed: (tick: number) => number, jitter = 0, tamper = false) => {
    const hb: { tick: number; h: number; at: number }[] = [];
    let h = HASH_SEED, wall = 1e6;
    for (let t = 0; t < inputs.length; t++) {
      h = hashStep(h, tamper && t === 2000 ? { ...inputs[t], mz: 0 } : inputs[t]);
      wall += TICK_MS / speed(t);
      if ((t + 1) % HB_EVERY_TICKS === 0) hb.push({ tick: t + 1, h, at: Math.round(wall + (Math.random() - 0.5) * jitter) });
    }
    return hb;
  };
  const n = inputs.length;
  check(checkHeartbeats(beats(() => 1, 300), inputs, n) === null, 'attestation: real-time run with 300ms network jitter passes');
  check(checkHeartbeats(beats(() => 0.5), inputs, n) !== null, `attestation: half-speed run rejected (${checkHeartbeats(beats(() => 0.5), inputs, n)})`);
  check(checkHeartbeats(beats(() => 0.85), inputs, n) !== null, `attestation: 85%-speed run rejected (${checkHeartbeats(beats(() => 0.85), inputs, n)})`);
  const slowFast = (t: number) => (t < n / 2 ? 0.6 : 1.4);
  check(checkHeartbeats(beats(slowFast), inputs, n) !== null, `attestation: slow-then-fast compensation rejected (${checkHeartbeats(beats(slowFast), inputs, n)})`);
  const alt = (t: number) => (Math.floor(t / 1200) % 2 ? 1.25 : 0.8);
  check(checkHeartbeats(beats(alt), inputs, n) !== null, `attestation: alternating 80%/125% speed rejected (${checkHeartbeats(beats(alt), inputs, n)})`);
  check(checkHeartbeats(beats(() => 0.9), inputs, n) !== null, `attestation: steady 90% speed rejected (${checkHeartbeats(beats(() => 0.9), inputs, n)})`);
  const stall = beats(() => 1).map((b, i) => (i === 30 ? { ...b, at: b.at + 600 } : b));
  check(checkHeartbeats(stall, inputs, n) === null, 'attestation: a single 600 ms network stall is tolerated');
  check(checkHeartbeats(beats(() => 1, 0, true), inputs, n) !== null, 'attestation: inputs edited after the fact rejected');
  check(inputsDigest(inputs) === inputsDigest(decodeInputs(encodeInputs(inputs))), 'digest is stable across encode/decode');
}

process.exit(fail ? 1 : 0);
