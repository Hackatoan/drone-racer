# Drone Racer

Fast 3D FPV drone racing in the browser: replay-verified leaderboards, hourly knockout tournaments, team PvP and a community map editor.

🔗 **Live:** [drone.hackatoa.com](https://drone.hackatoa.com) · ☕ [Support](https://buymeacoffee.com/hackatoa)

## Overview

Fly a quad in first or third person through checkpoint courses at up to ~230 km/h. Every time-trial run is recorded as a deterministic input file: the server re-simulates it with the same physics code to get the official time, so leaderboard times can't be faked, and any run can be watched or raced as a ghost.

## Features

- **Flight** — responsive arcade mode (mouse aims, W flies where you look, drone tilts into its acceleration) plus a real acro/rate mode for gamepads; FPV and chase cameras; boost; level-flight and precision modifiers.
- **Controls** — every action rebindable (keyboard, mouse buttons, wheel, gamepad buttons/axes), up to 3 binds each, per-bind strength, deadzone/curve/sensitivity, keyboard ramp-up; presets for WASD+mouse, arrow keys, keyboard-only, mouse-only, left-handed and gamepad.
- **Time trials** — 1–10 laps, instant restart, splits vs PB/WR/author, PB/WR/author/any-run ghosts, author/gold/silver/bronze medals, downloadable `.dronerun` replays.
- **Deterministic replays** — fixed 120 Hz physics using only `+ − × ÷ √` (custom sin/cos/atan/exp), so a run file reproduces the exact same time in any browser and on the server.
- **Anti-cheat** — runs are attested live (tick + rolling input hash heartbeats timestamped by the server, checked over sliding windows to catch slowed-down play), one submission per attempt, per-pilot duplicate detection.
- **Online** — races (up to 8, drone collisions on/off), shared time trials with friends, free roam, PvP free-for-all and 2v2/3v3/4v4 team deathmatch on procedurally generated arenas with lag-compensated server-side hit detection.
- **Hourly tournaments** — queue, 10-minute qualifier, divisions of 8 by qualifying time, knockout rounds eliminating the slowest until one pilot remains.
- **Map editor** — terrain generator + raise/lower/flatten/smooth brushes, start/finish line, ordered checkpoints, objects with built-in or uploaded textures, undo/redo, auto-check by autopilot, and mandatory validation (the author's own run becomes the author time) before publishing.
- **Community** — map browser, ratings and reviews, reports with auto-hide and a moderation queue, friends, direct messages and room invites.
- **Garage** — three frame styles, colors, decals; Premium (Stripe) unlocks uploading custom skin textures.

## Tech Stack

TypeScript everywhere · three.js + Vite client · Node + Express + `ws` server · Postgres (shared games DB; PGlite for local dev) · Firebase Authentication (Google) verified with `jose` · Stripe Checkout (REST) · Docker/GHCR.

## Development

```bash
npm install
npm run dev        # server :3043 (dev auth on) + Vite :5180
npm test           # determinism, replay, attestation self-tests
npm run nettest -- pvp|race|tourney   # protocol tests against a running dev server
```

`shared/` holds everything both sides run (physics, collision, map format, course logic, replay encoding, map generation). Dev sign-in accepts `dev:<uid>` tokens when `AUTH_DEV=1`.

## Deployment

`main` builds `ghcr.io/hackatoan/drone-racer:latest`; the Oracle games box runs it in the central games compose (see `docker-compose.example.yml`) behind NPMplus.

## Support

If you enjoy the game, you can support development at [buymeacoffee.com/hackatoa](https://buymeacoffee.com/hackatoa).

---

Part of the Hackatoa ecosystem · [All repositories »](https://github.com/Hackatoan?tab=repositories)
