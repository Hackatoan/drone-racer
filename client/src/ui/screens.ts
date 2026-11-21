import * as THREE from 'three';
import { h, clear, toast, modal, fmtMs, stars, put } from '../dom.ts';
import { me, settings, saveSettings, localPb } from '../state.ts';
import { net } from '../net.ts';
import { api, loadMap, getBoard, getRun, getAuthorRun, medals, medalFor, type MapMeta, type LoadedMap, type BoardRow } from '../api.ts';
import { stripeEnabled } from '../auth.ts';
import { app, go, topbar, doSignIn, startRoomQuick, tourneyLine, refresh } from './app.ts';
import { Session, renderer, camera, getControls } from '../game.ts';
import { buildDrone } from '../drone.ts';
import { GHOST_COLORS } from '../drone.ts';
import { mapThumb } from '../thumb.ts';
import { download, pickFile } from '../runfile.ts';
import { openEditor } from './editor.ts';
import { ACTIONS, ANALOG, PRESETS, DEFAULT_OPTS, describe, type Action, type Binding } from '../input.ts';
import { FRAMES, DECALS, type Skin } from '../../../shared/skins.ts';
import { setVolume } from '../audio.ts';
import { setTexturePolicy, swatch } from '../textures.ts';
import type { RunFile } from '../../../shared/replay.ts';
import type { RoomMode } from '../../../shared/protocol.ts';

// ================================================================ main menu

export function menu(): HTMLElement {
  const tour = h('div.card');
  const renderTour = () => {
    clear(tour);
    const t = app.tourney;
    const queued = !!(t && me.name && t.queued.includes(me.name));
    put(tour,
      h('div.row', null, h('h3', { style: { margin: 0 } }, '🏆 Hourly tournament'), h('div.grow'), t ? h('span.pill' + (t.phase !== 'idle' ? '.live' : ''), null, t.phase) : null),
      h('div.dim', { style: { margin: '6px 0' } }, tourneyLine(t) || 'Connecting…'),
      t && t.queued.length ? h('div', { style: { fontSize: '13px' } }, `Queued (${t.queued.length}): ${t.queued.slice(0, 12).join(', ')}${t.queued.length > 12 ? '…' : ''}`) : null,
      h('div.row', { style: { marginTop: '8px' } },
        !me.uid ? h('button.btn.sm.primary', { onclick: doSignIn }, 'Sign in to compete')
          : t?.phase === 'knockout' ? null
          : h('button.btn.sm' + (queued ? '.on' : '.primary'), { onclick: () => net.send({ t: 'tqueue', v: !queued }) }, queued ? 'Queued ✓ (leave)' : 'Queue for tournament'),
        t?.phase === 'qualifying' && queued ? h('button.btn.sm.primary', { onclick: () => flyQualifier() }, 'Fly qualifier') : null,
        h('button.btn.sm', { onclick: () => go(tourneyScreen) }, 'Details'),
      ),
    );
  };
  renderTour();
  app.listeners.add(renderTour);
  const tick = setInterval(() => { if (!tour.isConnected) clearInterval(tick); else renderTour(); }, 20_000);

  const modeBtn = (title: string, sub: string, fn: () => void, primary = false) =>
    h('button.btn' + (primary ? '.primary' : ''), { onclick: fn }, title, h('small', null, sub));

  return h('div.screen', null, h('div.wrap', null,
    topbar(),
    h('div.menu', null,
      h('div', null,
        h('div.logo', null, 'DRONE', h('span', null, ' RACER')),
        h('div.dim', null, 'Fast FPV drone racing. Replay-verified leaderboards, hourly knockout tournaments, team PvP and a community map editor.'),
        h('div.menu-btns', null,
          modeBtn('Time Trial', 'Ghosts, splits, medals, leaderboards', () => go(() => mapBrowser('tt')), true),
          modeBtn('Online Race', 'Race up to 8 pilots', () => go(onlineScreen), true),
          modeBtn('PvP Arena', 'FFA · 2v2 · 3v3 · 4v4 on random maps', () => go(pvpScreen)),
          modeBtn('Free Roam', 'Explore any map, solo or online', () => go(() => mapBrowser('free'))),
          modeBtn('Community Maps', 'Browse, rate & play player tracks', () => go(() => mapBrowser('tt', 'community'))),
          modeBtn('Map Editor', 'Build, test, validate & publish', () => openEditor(null, menu)),
          modeBtn('Leaderboards', 'Tournaments, races, PvP', () => go(boardsScreen)),
          modeBtn('Garage', 'Customize your drone', () => go(garage)),
          modeBtn('Settings', 'Controls, keybinds, graphics', () => go(settingsScreen)),
          modeBtn('Watch a run file', 'Play back a .dronerun', watchFile),
        ),
      ),
      h('div.side', null,
        tour,
        h('div.card', null,
          h('h3', null, 'Controls (default)'),
          h('div.dim', { style: { fontSize: '13px' } },
            'Mouse aims · ', h('span.kbd', null, 'W'), ' flies where you look · ', h('span.kbd', null, 'A'), h('span.kbd', null, 'D'), ' strafe · ',
            h('span.kbd', null, 'Space'), '/', h('span.kbd', null, 'C'), ' up/down · ', h('span.kbd', null, 'Shift'), ' boost · ', h('span.kbd', null, 'Q'), ' level flight · ',
            h('span.kbd', null, 'X'), ' precision · ', h('span.kbd', null, 'R'), ' respawn · ', h('span.kbd', null, '⌫'), ' restart · ', h('span.kbd', null, 'V'), ' camera. Gamepads work out of the box. Everything is rebindable in Settings.'),
        ),
        me.admin ? h('button.btn', { onclick: () => go(adminScreen) }, 'Moderation queue') : null,
        h('div.dim', { style: { fontSize: '12px' } }, 'Part of ', h('a', { href: 'https://games.hackatoa.com', style: { color: 'var(--accent2)' } }, 'Hackatoa Games'), ' · ', h('a', { href: '#', onclick: (e: Event) => { e.preventDefault(); premiumModal(); }, style: { color: 'var(--gold)' } }, 'Premium'), ' · ', h('a', { href: '/privacy.html', style: { color: 'var(--dim)' } }, 'Privacy'), ' · ', h('a', { href: '/terms.html', style: { color: 'var(--dim)' } }, 'Terms')),
      ),
    ),
  ));
}

async function watchFile() {
  const txt = await pickFile('.dronerun,application/json');
  if (!txt) return;
  try {
    const run = JSON.parse(txt) as RunFile;
    if (run.kind !== 'drone-run') throw new Error('not a run file');
    const m = await loadMap(run.mapId);
    startReplay(m, run, menu);
  } catch (e) { toast(`Can't open: ${(e as Error).message}`, { err: true }); }
}

export function startReplay(m: LoadedMap, run: RunFile, back: () => HTMLElement) {
  go(() => h('div.screen.clear'));
  app.session = new Session({ kind: 'replay', mapId: m.id, map: m.map, meta: m.meta, laps: run.laps, replay: run, onExit: () => { app.session = null; go(back); } });
}

async function flyQualifier() {
  const t = app.tourney;
  if (!t?.mapId) return;
  const m = await loadMap(t.mapId);
  startTimeTrial(m, t.laps, menu, { qualifier: true });
}

// ================================================================ map browser

export function mapBrowser(purpose: 'tt' | 'free', tab: 'official' | 'community' = 'official'): HTMLElement {
  const grid = h('div.grid');
  let sort = 'top', q = '';
  const tabs = h('div.tabs');
  const load = async () => {
    clear(tabs).append(
      h('button' + (tab === 'official' ? '.on' : ''), { onclick: () => { tab = 'official'; load(); } }, 'Official'),
      h('button' + (tab === 'community' ? '.on' : ''), { onclick: () => { tab = 'community'; load(); } }, 'Community'),
    );
    clear(grid).append(h('div.dim', null, 'Loading…'));
    try {
      const r = await api<{ maps: MapMeta[] }>(`/maps?tab=${tab}&sort=${sort}&q=${encodeURIComponent(q)}`);
      clear(grid);
      if (!r.maps.length) grid.append(h('div.dim', null, 'No maps yet — build one in the editor!'));
      for (const m of r.maps) grid.append(mapCard(m, () => go(() => mapDetail(m.id, purpose, () => mapBrowser(purpose, tab)))));
    } catch (e) { clear(grid).append(h('div.dim', null, (e as Error).message)); }
  };
  const controls = h('div.row', { style: { marginBottom: '12px' } },
    h('input', { type: 'search', placeholder: 'Search maps or authors', oninput: (e: any) => { q = e.target.value; clearTimeout((controls as any)._t); (controls as any)._t = setTimeout(load, 300); } }),
    h('select', { onchange: (e: any) => { sort = e.target.value; load(); } }, ...[['top', 'Popular'], ['rating', 'Top rated'], ['new', 'Newest'], ['plays', 'Most played']].map(([v, l]) => h('option', { value: v }, l))),
  );
  load();
  return h('div.screen', null, h('div.wrap', null, topbar(purpose === 'tt' ? 'Choose a track' : 'Free roam — choose a map', () => go(menu)), tabs, controls, grid));
}

function mapCard(m: MapMeta, onclick: () => void) {
  const thumb = h('div.thumb');
  if (m.thumb) thumb.style.backgroundImage = `url(${m.thumb})`;
  else loadMap(m.id).then((lm) => { thumb.style.backgroundImage = `url(${mapThumb(lm.map, 320, 200, m.id)})`; }).catch(() => {});
  return h('div.card.click', { onclick }, thumb,
    h('div.row', null, h('b', null, m.name), h('div.grow'), m.official ? h('span.pill', null, 'Official') : null),
    h('div.dim', { style: { fontSize: '13px' } }, `by ${m.author} · ${m.checkpoints} CPs · ${m.laps} laps`),
    h('div.row', { style: { fontSize: '13px', marginTop: '4px' } }, h('span.medal.m-author'), fmtMs(m.authorMs), h('div.grow'),
      m.official ? null : h('span', null, h('span.stars', null, stars(m.rating)), h('span.dim', null, ` ${m.ratings} · ${m.plays} plays`))));
}

// ================================================================ map detail

export function mapDetail(id: string, purpose: 'tt' | 'free', back: () => HTMLElement): HTMLElement {
  const root = h('div.wrap', null, topbar(undefined, () => go(back)), h('div.dim', null, 'Loading…'));
  const self = () => mapDetail(id, purpose, back);
  loadMap(id).then((m) => {
    clear(root).append(topbar(m.map.name, () => go(back)));
    const meta = m.meta;
    const aMs = meta?.authorMs ?? 0;
    const md = medals(aMs);
    let laps = m.map.laps;
    const ghostSel = { ...settings.ghosts };
    const extraGhosts: { run: RunFile; label: string; color: number }[] = [];
    const board = h('div');
    const lapTabs = h('div.tabs');
    const head = h('div.row', { style: { alignItems: 'flex-start', gap: '20px' } },
      h('img', { src: meta?.thumb ?? mapThumb(m.map, 320, 200, m.id), style: { width: '320px', maxWidth: '100%', borderRadius: '10px', border: '1px solid var(--line)' } }),
      h('div.col.grow', null,
        h('div.dim', null, `by ${m.map.author || meta?.author} · ${m.map.checkpoints.length} checkpoints · default ${m.map.laps} laps · ${m.map.sky}`),
        m.map.desc ? h('div', null, m.map.desc) : null,
        aMs ? h('div.row', { style: { fontSize: '13px' } },
          h('span', null, h('span.medal.m-author'), `Author ${fmtMs(md.author)}`), h('span', null, h('span.medal.m-gold'), fmtMs(md.gold)),
          h('span', null, h('span.medal.m-silver'), fmtMs(md.silver)), h('span', null, h('span.medal.m-bronze'), fmtMs(md.bronze)),
          h('span.dim', null, `(for ${m.map.laps} lap${m.map.laps > 1 ? 's' : ''})`)) : null,
        meta && !meta.official ? h('div', null, h('span.stars', null, stars(meta.rating)), h('span.dim', null, ` ${meta.ratings} ratings · ${meta.plays} plays`)) : null,
        h('div.row', null,
          h('label.row', null, 'Laps', h('select', { onchange: (e: any) => { laps = +e.target.value; loadBoard(); } }, ...Array.from({ length: 10 }, (_, i) => h('option', { value: i + 1, selected: i + 1 === laps }, i + 1)))),
          h('label.row', null, h('input', { type: 'checkbox', checked: ghostSel.pb, onchange: (e: any) => { ghostSel.pb = e.target.checked; } }), 'My PB ghost'),
          h('label.row', null, h('input', { type: 'checkbox', checked: ghostSel.wr, onchange: (e: any) => { ghostSel.wr = e.target.checked; } }), 'WR ghost'),
          h('label.row', null, h('input', { type: 'checkbox', checked: ghostSel.author, onchange: (e: any) => { ghostSel.author = e.target.checked; } }), 'Author ghost'),
          h('label.row', null, 'Splits vs', h('select', { onchange: (e: any) => { settings.splitRef = e.target.value; saveSettings(); } }, ...(['pb', 'wr', 'author'] as const).map((v) => h('option', { value: v, selected: settings.splitRef === v }, v.toUpperCase())))),
        ),
        h('div.row', null,
          purpose === 'tt' ? h('button.btn.primary', { onclick: () => { settings.ghosts = ghostSel; saveSettings(); startTimeTrial(m, laps, self, { ghosts: ghostSel, extra: extraGhosts }); } }, '▶ Time trial') : null,
          h('button.btn' + (purpose === 'free' ? '.primary' : ''), { onclick: () => startFree(m, self) }, 'Free roam'),
          h('button.btn', { onclick: () => createRoom('race', m.id, laps) }, 'Host race'),
          h('button.btn', { onclick: () => createRoom('tt', m.id, laps) }, 'Time trial with friends'),
          h('button.btn', { onclick: () => createRoom('freeroam', m.id, laps) }, 'Online free roam'),
          h('button.btn.ghost', { onclick: () => openEditor({ ...structuredClone(m.map), name: `${m.map.name} (remix)` }, self) }, 'Remix in editor'),
          h('button.btn.ghost', { onclick: () => download(`${m.map.name.replace(/\W+/g, '_')}.dronemap.json`, m.map) }, 'Download map'),
          meta && !meta.official ? h('button.btn.ghost.danger', { onclick: () => report('map', m.id) }, 'Report map') : null,
        ),
        extraGhosts.length ? h('div.dim', null, `Racing ghosts: ${extraGhosts.map((g) => g.label).join(', ')}`) : null,
      ),
    );
    const loadBoard = async () => {
      clear(board).append(h('div.dim', null, 'Loading leaderboard…'));
      try {
        const r = await getBoard(m.id, laps);
        clear(lapTabs).append(...r.laps.map((l) => h('button' + (l.laps === laps ? '.on' : ''), { onclick: () => { laps = l.laps; loadBoard(); } }, `${l.laps} lap${l.laps > 1 ? 's' : ''} (${l.n})`)));
        clear(board).append(boardTable(m, r.runs, laps, aMs, extraGhosts, self));
      } catch (e) { clear(board).append(h('div.dim', null, (e as Error).message)); }
    };
    loadBoard();
    root.append(head, h('h3', { style: { marginTop: '22px' } }, 'Leaderboard'), lapTabs, board);
    if (meta && !meta.official) root.append(reviews(m.id));
  }).catch((e) => clear(root).append(topbar('Map', () => go(back)), h('div.dim', null, e.message)));
  return h('div.screen', null, root);
}

function boardTable(m: LoadedMap, runs: BoardRow[], laps: number, authorMs: number, extra: { run: RunFile; label: string; color: number }[], back: () => HTMLElement) {
  if (!runs.length) return h('div.dim', null, `No ${laps}-lap times yet. Be the first!`);
  const scale = laps / m.map.laps;
  return h('table.t', null,
    h('tr', null, ['#', 'Pilot', 'Time', 'Best lap', 'Mode', ''].map((x) => h('th', null, x))),
    runs.map((r) => {
      const medal = authorMs && laps === m.map.laps ? medalFor(r.ms, authorMs) : authorMs ? medalFor(r.ms / scale, authorMs) : null;
      return h('tr', { class: r.player === me.name ? 'me' : '' },
        h('td', null, r.rank), h('td', null, medal ? h(`span.medal.m-${medal}`) : null, r.player),
        h('td.mono', null, fmtMs(r.ms)), h('td.mono.dim', null, fmtMs(Math.min(...r.lapTimes))), h('td.dim', null, r.mode),
        h('td', null, h('div.row', null,
          h('button.btn.sm', { onclick: async () => startReplay(m, await getRun(r.id), back) }, 'Watch'),
          h('button.btn.sm', { onclick: async () => { extra.push({ run: await getRun(r.id), label: r.player, color: GHOST_COLORS.other }); toast(`${r.player}'s ghost added — press Time trial`); } }, 'Race ghost'),
          h('button.btn.sm.ghost', { onclick: async () => download(`${r.player}_${r.ms}.dronerun`, await getRun(r.id)) }, '⤓'),
          h('button.btn.sm.ghost', { title: 'Report this run', onclick: () => report('run', r.id) }, '⚑'))));
    }));
}

function reviews(mapId: string) {
  const box = h('div', { style: { marginTop: '22px' } }, h('h3', null, 'Reviews'));
  const list = h('div.col');
  let starsVal = 5;
  const starRow = h('div.row');
  const drawStars = () => { clear(starRow).append(...[1, 2, 3, 4, 5].map((n) => h('button.btn.sm' + (n <= starsVal ? '.on' : ''), { onclick: () => { starsVal = n; drawStars(); } }, '★'))); };
  drawStars();
  const text = h('textarea', { rows: 2, maxLength: 500, placeholder: 'What did you think? (optional)', style: { width: '100%' } }) as HTMLTextAreaElement;
  const load = async () => {
    try {
      const r = await api<{ reviews: { player: string; stars: number; body: string; at: string; id: string }[] }>(`/maps/${encodeURIComponent(mapId)}/reviews`);
      clear(list).append(...(r.reviews.length ? r.reviews.map((rv) => h('div.card', null,
        h('div.row', null, h('b', null, rv.player), h('span.stars', null, stars(rv.stars)), h('div.grow'), h('button.btn.sm.ghost', { title: 'Report review', onclick: () => report('review', rv.id) }, '⚑')),
        rv.body ? h('div', null, rv.body) : null)) : [h('div.dim', null, 'No reviews yet.')]));
    } catch { /* ignore */ }
  };
  load();
  put(box,
    me.uid ? h('div.card.col', { style: { marginBottom: '10px' } }, h('div.row', null, 'Your rating', starRow), text,
      h('button.btn.primary', { onclick: async () => { try { await api(`/maps/${encodeURIComponent(mapId)}/reviews`, { body: { stars: starsVal, body: text.value } }); toast('Review saved'); text.value = ''; load(); } catch (e) { toast((e as Error).message, { err: true }); } } }, 'Submit review'))
      : h('div.dim', null, 'Sign in to rate and review.'),
    list);
  return box;
}

export function report(kind: 'map' | 'run' | 'review' | 'texture' | 'pilot', target: string) {
  if (!me.uid) { toast('Sign in to report'); return; }
  const reasons: Record<string, string[]> = {
    map: ['Broken / impossible to finish', 'Shortcut exploit', 'Offensive content', 'Copy of another map', 'Other'],
    run: ['Uses a map exploit / bug', 'Suspected cheating / tool-assisted', 'Other'],
    review: ['Spam', 'Offensive', 'Other'], texture: ['Offensive / inappropriate', 'Copyright', 'Other'], pilot: ['Offensive name', 'Harassment', 'Other'],
  };
  let reason = reasons[kind][0];
  const detail = h('input', { type: 'text', maxLength: 200, placeholder: 'Details (optional)', style: { width: '100%' } }) as HTMLInputElement;
  modal(`Report ${kind}`, h('div.col', null,
    h('select', { onchange: (e: any) => (reason = e.target.value) }, ...reasons[kind].map((r) => h('option', null, r))), detail,
    h('div.dim', { style: { fontSize: '12px' } }, 'Items with several reports are hidden automatically until a moderator reviews them.')), [
    ['Cancel', () => {}],
    ['Send report', () => { api('/reports', { body: { kind, target, reason: `${reason}${detail.value ? `: ${detail.value}` : ''}` } }).then(() => toast('Thanks — report received')).catch((e) => toast(e.message, { err: true })); }, 'primary'],
  ]);
}

// ================================================================ starting sessions

export async function startTimeTrial(m: LoadedMap, laps: number, back: () => HTMLElement, opts: { ghosts?: { pb: boolean; wr: boolean; author: boolean }; extra?: { run: RunFile; label: string; color: number }[]; qualifier?: boolean } = {}) {
  const ghosts = [...(opts.extra ?? [])];
  const g = opts.ghosts ?? settings.ghosts;
  const pb = localPb(m.id, laps, m.hash);
  let wr: RunFile | null = null, author: RunFile | null = null;
  try { const b = await getBoard(m.id, laps); if (b.runs[0]) wr = await getRun(b.runs[0].id); } catch { /* offline */ }
  if (laps === m.map.laps) try { author = await getAuthorRun(m.id); } catch { /* none */ }
  if (g.pb && pb) ghosts.push({ run: pb, label: 'Your PB', color: GHOST_COLORS.pb });
  if (g.wr && wr) ghosts.push({ run: wr, label: `WR · ${wr.player}`, color: GHOST_COLORS.wr });
  if (g.author && author) ghosts.push({ run: author, label: 'Author', color: GHOST_COLORS.author });
  const ref = settings.splitRef === 'wr' ? wr ?? pb : settings.splitRef === 'author' ? author ?? pb : pb ?? wr;
  if (!m.id.startsWith('o:')) api(`/maps/${encodeURIComponent(m.id)}/play`, { body: {} }).catch(() => {});
  go(() => h('div.screen.clear'));
  app.session = new Session({ kind: 'timetrial', mapId: m.id, map: m.map, meta: m.meta, laps, ghosts, splitRef: ref, onExit: () => { app.session = null; go(back); } });
  if (opts.qualifier) toast('Tournament qualifier: every finished run is submitted — your best counts');
}

function startFree(m: LoadedMap, back: () => HTMLElement) {
  go(() => h('div.screen.clear'));
  app.session = new Session({ kind: 'freeroam', mapId: m.id, map: m.map, meta: m.meta, laps: m.map.laps, onExit: () => { app.session = null; go(back); } });
}

function createRoom(mode: RoomMode, mapId: string, laps: number, priv = false) {
  net.send({ t: 'create', opts: { mode, mapId, laps, collide: mode === 'race', priv, max: 8, teamSize: 0 } });
}

// ================================================================ online lobby

export function onlineScreen(): HTMLElement {
  const list = h('div.col');
  const code = h('input', { type: 'text', maxLength: 5, placeholder: 'Room code', style: { width: '120px', textTransform: 'uppercase' } }) as HTMLInputElement;
  const off = net.on('rooms', (m) => {
    if (!list.isConnected) { off(); return; }
    clear(list).append(...(m.list.length ? m.list.map((r) => h('div.card.row', null,
      h('b', null, r.mode === 'tt' ? 'TIME TRIAL' : r.mode.toUpperCase()), h('span', null, r.mapName), h('span.dim', null, `${r.players}/${r.max} · ${r.phase}${r.mode === 'race' ? ` · ${r.laps} laps · collisions ${r.collide ? 'on' : 'off'}` : ''}${r.teamSize ? ` · ${r.teamSize}v${r.teamSize}` : ''}`),
      h('div.grow'), h('button.btn.sm.primary', { onclick: () => net.send({ t: 'join', id: r.id }) }, 'Join'))) : [h('div.dim', null, 'No public rooms right now — quick-join creates one.')]));
  });
  const poll = setInterval(() => { if (!list.isConnected) { clearInterval(poll); return; } net.send({ t: 'list' }); }, 3000);
  net.send({ t: 'list' });
  // create form
  const f = { mode: 'race' as RoomMode, mapId: 'o:meadow-loop', laps: 3, collide: true, priv: false };
  const mapSel = h('select', { onchange: (e: any) => (f.mapId = e.target.value) });
  api<{ maps: MapMeta[] }>('/maps?tab=official').then((r) => mapSel.append(...r.maps.map((m) => h('option', { value: m.id }, m.name))));
  api<{ maps: MapMeta[] }>('/maps?tab=community&sort=top').then((r) => r.maps.length && mapSel.append(h('optgroup', { label: 'Community' }, ...r.maps.map((m) => h('option', { value: m.id }, `${m.name} — ${m.author}`)))));
  return h('div.screen', null, h('div.wrap', null, topbar('Online', () => go(menu)),
    h('div.row', { style: { marginBottom: '16px' } },
      h('button.btn.primary', { onclick: () => startRoomQuick('race') }, 'Quick race'),
      h('button.btn', { onclick: () => startRoomQuick('freeroam') }, 'Quick free roam'),
      h('button.btn', { onclick: () => startRoomQuick('tt') }, 'Quick shared time trial'),
      h('button.btn', { onclick: () => go(pvpScreen) }, 'PvP →'),
      h('div.grow'), code, h('button.btn', { onclick: () => code.value.trim() && net.send({ t: 'join', id: code.value.trim().toUpperCase() }) }, 'Join code')),
    h('div.card', { style: { marginBottom: '16px' } }, h('h3', null, 'Create a room'),
      h('div.row', null,
        h('select', { onchange: (e: any) => (f.mode = e.target.value) }, h('option', { value: 'race' }, 'Race'), h('option', { value: 'tt' }, 'Shared time trial'), h('option', { value: 'freeroam' }, 'Free roam')),
        mapSel,
        h('label.row', null, 'Laps', h('input', { type: 'number', min: 1, max: 10, value: 3, style: { width: '60px' }, onchange: (e: any) => (f.laps = +e.target.value) })),
        h('label.row', null, h('input', { type: 'checkbox', checked: true, onchange: (e: any) => (f.collide = e.target.checked) }), 'Drone collisions'),
        h('label.row', null, h('input', { type: 'checkbox', onchange: (e: any) => (f.priv = e.target.checked) }), 'Private (code only)'),
        h('button.btn.primary', { onclick: () => net.send({ t: 'create', opts: { ...f, max: 8, teamSize: 0 } }) }, 'Create'))),
    h('h3', null, 'Public rooms'), list));
}

export function pvpScreen(): HTMLElement {
  const card = (title: string, sub: string, ts: 0 | 2 | 3 | 4) => h('button.btn', { style: { padding: '22px', textAlign: 'left' }, onclick: () => startRoomQuick('pvp', ts) }, h('h2', { style: { margin: 0 } }, title), h('div.dim', null, sub));
  return h('div.screen', null, h('div.wrap', null, topbar('PvP Arena', () => go(menu)),
    h('div.dim', { style: { marginBottom: '14px' } }, 'Drones carry a rapid blaster (fire) and a charged railgun (alt fire). Every match is on a freshly generated arena. 5 minutes or kill limit; friendly fire is off in team modes.'),
    h('div.grid', null, card('Free-for-all', 'Up to 8 pilots · first to 20', 0), card('2 v 2', 'Team deathmatch · first to 20', 2), card('3 v 3', 'Team deathmatch · first to 30', 3), card('4 v 4', 'Team deathmatch · first to 40', 4)),
    h('div.dim', { style: { marginTop: '14px' } }, 'Want a private match? Create a PvP room and share the code: ', h('button.btn.sm', { onclick: () => net.send({ t: 'create', opts: { mode: 'pvp', mapId: '', laps: 1, collide: true, priv: true, max: 8, teamSize: 0 } }) }, 'Private FFA'))));
}

// ================================================================ leaderboards & tournaments

export function boardsScreen(): HTMLElement {
  const body = h('div');
  const tabs = h('div.tabs');
  const cols: [string, string, (r: any) => string][] = [
    ['tourney_points', 'Tournament points', (r) => `${r.tourney_points} pts · ${r.tourney_wins} wins / ${r.tourneys}`],
    ['race_wins', 'Race wins', (r) => `${r.race_wins} / ${r.races} races`],
    ['pvp_wins', 'PvP wins', (r) => `${r.pvp_wins} / ${r.pvp_matches} matches`],
    ['kills', 'PvP kills', (r) => `${r.kills} K / ${r.deaths} D · ${(r.kills / Math.max(1, r.deaths)).toFixed(2)} K/D`],
  ];
  const load = async (k: string) => {
    clear(tabs).append(...cols.map(([key, label]) => h('button' + (key === k ? '.on' : ''), { onclick: () => load(key) }, label)), h('button', { onclick: () => go(() => mapBrowser('tt')) }, 'Map times →'));
    clear(body).append(h('div.dim', null, 'Loading…'));
    const r = await api<{ stats: any[] }>(`/stats?sort=${k}`);
    const fmt = cols.find((c) => c[0] === k)![2];
    clear(body).append(r.stats.length ? h('table.t', null, h('tr', null, h('th', null, '#'), h('th', null, 'Pilot'), h('th', null, '')),
      r.stats.map((s, i) => h('tr', { class: s.player === me.name ? 'me' : '' }, h('td', null, i + 1), h('td', null, s.player), h('td.mono', null, fmt(s))))) : h('div.dim', null, 'Nothing here yet.'));
  };
  load('tourney_points');
  return h('div.screen', null, h('div.wrap', null, topbar('Leaderboards', () => go(menu)), tabs, body));
}

export function tourneyScreen(): HTMLElement {
  const body = h('div.col');
  const render = () => {
    const t = app.tourney;
    clear(body);
    if (!t) { body.append(h('div.dim', null, 'Connecting…')); return; }
    put(body,
      h('div.card', null, h('h3', null, tourneyLine(t)),
        h('div.dim', null, 'Every hour: queue up → 10-minute qualifier (best verified time trial on the chosen map) → divisions of 8 by qualifying time → knockout rounds where the slowest pilots are eliminated each round until one is left. Points for every placement; Division 1 winner takes the tournament.'),
        t.queued.length ? h('div', { style: { marginTop: '8px' } }, `Queued: ${t.queued.join(', ')}`) : null),
      t.qualifiers.length ? h('div.card', null, h('h3', null, `Qualifying — ${t.mapName} (${t.laps} lap${t.laps > 1 ? 's' : ''})`),
        h('table.t', null, t.qualifiers.map((q, i) => h('tr', { class: q.name === me.name ? 'me' : '' }, h('td', null, `${i + 1}`), h('td', null, q.name), h('td.mono', null, fmtMs(q.ms)), h('td.dim', null, `Div ${Math.floor(i / 8) + 1}`))))) : null,
      t.divisions.length ? h('div.grid', null, t.divisions.map((d) => h('div.card', null, h('h3', null, `Division ${d.div}`), h('div', null, d.players.join(', ')), h('div', { style: { marginTop: '6px', color: 'var(--gold)' } }, d.winner ? `🏆 ${d.winner}` : 'In progress…')))) : null,
    );
  };
  render();
  app.listeners.add(render);
  const hist = h('div');
  api<{ tourneys: any[] }>('/tourneys').then((r) => hist.append(h('h3', { style: { marginTop: '20px' } }, 'Past tournaments'),
    r.tourneys.length ? h('table.t', null, r.tourneys.map((x) => h('tr', null, h('td.dim', null, new Date(x.started_at).toLocaleString()), h('td', null, x.data.mapName), h('td', null, `🏆 ${x.data.divisions?.[0]?.winner ?? '—'}`), h('td.dim', null, `${x.data.qualifiers?.length ?? 0} pilots`)))) : h('div.dim', null, 'None yet.')));
  return h('div.screen', null, h('div.wrap', null, topbar('Tournament', () => go(menu)), body, hist));
}

// ================================================================ garage

export function garage(): HTMLElement {
  const s = settings.skin;
  const scene = new THREE.Scene();
  scene.background = new THREE.Color(0x0b0e14);
  scene.add(new THREE.HemisphereLight(0xffffff, 0x334455, 1.4));
  const dl = new THREE.DirectionalLight(0xffffff, 2.2); dl.position.set(2, 3, 2); scene.add(dl);
  let mesh = buildDrone(s);
  scene.add(mesh.group);
  const rebuild = () => { scene.remove(mesh.group); mesh.dispose(); mesh = buildDrone(s); scene.add(mesh.group); saveSettings(); net.rehello(); };
  let raf = 0;
  const loop = (t: number) => {
    if (!panel.isConnected) { cancelAnimationFrame(raf); return; }
    raf = requestAnimationFrame(loop);
    mesh.group.rotation.y = t / 1600;
    mesh.group.rotation.x = Math.sin(t / 2000) * 0.15;
    mesh.update(1 / 60, 0.5);
    camera.position.set(0, 0.35, 1.25);
    camera.lookAt(0, 0, 0);
    camera.fov = 50; camera.updateProjectionMatrix();
    renderer.render(scene, camera);
  };
  raf = requestAnimationFrame(loop);
  const color = (k: keyof Skin, label: string) => h('label.row', null, h('input', { type: 'color', value: s[k] as string, oninput: (e: any) => { (s as any)[k] = e.target.value; rebuild(); } }), label);
  const panel = h('div.panel', { style: { position: 'absolute', right: '16px', top: '16px', bottom: '16px', width: 'min(360px, calc(100% - 32px))' } },
    h('div.row', null, h('button.btn.sm', { onclick: () => { camera.fov = settings.fov; camera.updateProjectionMatrix(); go(menu); } }, '← Back'), h('h2', { style: { margin: 0 } }, 'Garage')),
    h('h3', { style: { marginTop: '14px' } }, 'Frame'),
    h('div.row', null, FRAMES.map((fr) => h('button.btn.sm' + (s.frame === fr ? '.on' : ''), { onclick: () => { s.frame = fr; rebuild(); go(garage); } }, fr))),
    h('h3', { style: { marginTop: '14px' } }, 'Colors'),
    h('div.col', null, color('body', 'Body'), color('accent', 'Accent'), color('props', 'Props'), color('led', 'LEDs')),
    h('h3', { style: { marginTop: '14px' } }, 'Decal'),
    h('div.row', null, DECALS.map((d) => h('button.btn.sm' + (s.decal === d ? '.on' : ''), { onclick: () => { s.decal = d; delete s.tex; rebuild(); go(garage); } }, d))),
    h('h3', { style: { marginTop: '14px' } }, 'Custom skin texture'),
    me.premium
      ? h('div.col', null, h('div.dim', null, 'Upload a PNG/JPEG (max 300 KB) to wrap your drone body.'), h('button.btn', { onclick: () => uploadTexture('skin').then((k) => { if (k) { s.tex = k; rebuild(); } }) }, 'Upload skin image'), s.tex ? h('button.btn.ghost', { onclick: () => { delete s.tex; rebuild(); go(garage); } }, 'Remove custom texture') : null)
      : h('div.dim', null, 'Uploading your own skin files is a Premium feature. ', h('button.btn.sm', { onclick: premiumModal }, 'Learn more')),
  );
  return h('div.screen.clear', null, panel);
}

export async function uploadTexture(purpose: 'map' | 'skin'): Promise<string | null> {
  if (!me.uid) { toast('Sign in to upload textures'); return null; }
  return new Promise((res) => {
    const i = document.createElement('input');
    i.type = 'file';
    i.accept = 'image/png,image/jpeg,image/webp';
    i.onchange = () => {
      const f = i.files?.[0];
      if (!f) return res(null);
      if (f.size > 300_000) { toast('Max 300 KB', { err: true }); return res(null); }
      const rd = new FileReader();
      rd.onload = async () => {
        try { const r = await api<{ key: string }>('/textures', { body: { data: rd.result, name: f.name, purpose } }); toast('Uploaded'); res(r.key); }
        catch (e) { toast((e as Error).message, { err: true }); res(null); }
      };
      rd.readAsDataURL(f);
    };
    i.click();
  });
}

// ================================================================ premium / admin

export async function premiumModal() {
  if (!me.uid) { toast('Sign in first'); return; }
  let info = { enabled: stripeEnabled(), premium: me.premium, priceCents: 499, perks: ['Upload your own drone skin textures', 'Supporter badge next to your name'] };
  try { info = await api('/premium'); } catch { /* fallback */ }
  modal('Drone Racer Premium', h('div.col', null,
    h('div', null, info.premium ? 'You have Premium — thank you for supporting the game!' : `One-time $${(info.priceCents / 100).toFixed(2)}. Everything that affects gameplay stays free.`),
    h('ul', null, info.perks.map((p) => h('li', null, p))),
    !info.enabled ? h('div.dim', null, 'Purchases are not open yet.') : null), [
    ['Close', () => {}],
    ...(info.enabled && !info.premium ? [['Buy with Stripe', () => { api<{ url: string }>('/premium/checkout', { body: {} }).then((r) => (location.href = r.url)).catch((e) => toast(e.message, { err: true })); }, 'primary'] as [string, () => void, string]] : []),
  ]);
}

export function adminScreen(): HTMLElement {
  const body = h('div');
  const load = async () => {
    const r = await api<{ reports: any[] }>('/admin/reports');
    clear(body).append(r.reports.length ? h('table.t', null, h('tr', null, ['Kind', 'Target', 'Reports', 'Reasons', ''].map((x) => h('th', null, x))),
      r.reports.map((x) => h('tr', null, h('td', null, x.kind), h('td.mono', null, x.target), h('td', null, x.n), h('td.dim', null, x.reasons.slice(0, 3).join(' | ')),
        h('td', null, h('div.row', null,
          x.kind === 'map' ? h('button.btn.sm', { onclick: () => go(() => mapDetail(x.target, 'tt', adminScreen)) }, 'View') : null,
          h('button.btn.sm.danger', { onclick: () => act(x, 'remove') }, 'Remove'),
          h('button.btn.sm', { onclick: () => act(x, 'dismiss') }, 'Dismiss')))))) : h('div.dim', null, 'Queue is empty.'));
  };
  const act = async (x: any, action: string) => { await api('/admin/action', { body: { kind: x.kind, target: x.target, action } }); load(); };
  load().catch((e) => clear(body).append(h('div.dim', null, e.message)));
  return h('div.screen', null, h('div.wrap', null, topbar('Moderation', () => go(menu)), body));
}

// ================================================================ settings

export function settingsScreen(tab = 'controls'): HTMLElement {
  const body = h('div');
  const tabs = h('div.tabs');
  const T = [['controls', 'Controls & keybinds'], ['flight', 'Flight & camera'], ['graphics', 'Graphics'], ['audio', 'Audio']];
  const show = (t: string) => {
    tab = t;
    clear(tabs).append(...T.map(([k, l]) => h('button' + (k === t ? '.on' : ''), { onclick: () => show(k) }, l)));
    clear(body).append(t === 'controls' ? controlsTab() : t === 'flight' ? flightTab() : t === 'graphics' ? graphicsTab() : audioTab());
  };
  show(tab);
  return h('div.screen', null, h('div.wrap', null, topbar('Settings', () => { saveSettings(); go(menu); }), tabs, body));
}

const slider = (label: string, min: number, max: number, step: number, get: () => number, set: (v: number) => void, fmt = (v: number) => String(v)) => {
  const val = h('b', null, fmt(get()));
  return h('label.f', null, h('span', null, `${label} `, val), h('input', { type: 'range', min, max, step, value: get(), oninput: (e: any) => { set(+e.target.value); val.textContent = fmt(+e.target.value); saveSettings(); } }));
};
const check = (label: string, get: () => boolean, set: (v: boolean) => void) =>
  h('label.row', null, h('input', { type: 'checkbox', checked: get(), onchange: (e: any) => { set(e.target.checked); saveSettings(); } }), label);
const select = (label: string, opts: [string, string][], get: () => string, set: (v: string) => void) =>
  h('label.f', null, label, h('select', { onchange: (e: any) => { set(e.target.value); saveSettings(); } }, ...opts.map(([v, l]) => h('option', { value: v, selected: get() === v }, l))));

function flightTab() {
  return h('div.col', { style: { maxWidth: '520px' } },
    select('Flight mode', [['arcade', 'Arcade — aim with mouse/stick, W flies where you look (default)'], ['acro', 'Acro — real rate-mode quad (gamepad recommended)']], () => settings.flight, (v) => (settings.flight = v as any)),
    select('Default camera', [['fpv', 'First person (FPV)'], ['chase', 'Third person (chase)']], () => settings.camera, (v) => (settings.camera = v as any)),
    slider('Field of view', 60, 120, 1, () => settings.fov, (v) => (settings.fov = v), (v) => `${v}°`),
    slider('Acro camera uptilt', 0, 50, 1, () => settings.fpvTilt, (v) => (settings.fpvTilt = v), (v) => `${v}°`),
    slider('Acro rates', 0.5, 1.5, 0.05, () => settings.input.acroRates, (v) => (settings.input.acroRates = v), (v) => `${v.toFixed(2)}×`),
    check('Widen FOV with speed', () => settings.fovKick, (v) => (settings.fovKick = v)),
    check('Camera shake on impacts', () => settings.shake, (v) => (settings.shake = v)),
    check('Show nameplates', () => settings.nameplates, (v) => (settings.nameplates = v)),
  );
}

function graphicsTab() {
  return h('div.col', { style: { maxWidth: '520px' } },
    select('Quality (shadows, terrain detail, draw distance)', [['high', 'High'], ['med', 'Medium'], ['low', 'Low — fastest']], () => settings.quality, (v) => (settings.quality = v as any)),
    select('Textures', [['all', 'All (including custom uploads)'], ['builtin', 'Built-in only (skip custom uploads)'], ['none', 'Off — flat colors, fastest']], () => settings.textures, (v) => { settings.textures = v as any; setTexturePolicy(v as any); }),
    check('Show FPS / ping', () => settings.showFps, (v) => (settings.showFps = v)),
    h('div.dim', null, 'Quality changes apply to the next map you load (a page reload applies antialiasing changes).'),
  );
}

function audioTab() {
  return h('div.col', { style: { maxWidth: '520px' } }, slider('Master volume', 0, 1, 0.05, () => settings.volume, (v) => { settings.volume = v; setVolume(v); }, (v) => `${Math.round(v * 100)}%`));
}

function controlsTab(): HTMLElement {
  const I = settings.input;
  const wrap = h('div.col');
  const render = () => {
    clear(wrap);
    put(wrap,
      h('h3', null, 'Preset'),
      h('div.grid', null, Object.entries(PRESETS).map(([k, p]) => h('div.card.click' + (I.preset === k ? '' : ''), { style: I.preset === k ? { borderColor: 'var(--accent)' } : {}, onclick: () => { I.preset = k; I.bindings = p.make(); saveSettings(); render(); } }, h('b', null, p.name), h('div.dim', { style: { fontSize: '12px' } }, p.desc)))),
      h('div.row', { style: { margin: '10px 0' } },
        slider('Mouse sensitivity', 0.3, 8, 0.1, () => I.mouseSens, (v) => (I.mouseSens = v), (v) => v.toFixed(1)),
        slider('Stick / key look speed', 1, 8, 0.1, () => I.lookRate, (v) => (I.lookRate = v), (v) => `${v.toFixed(1)} rad/s`),
        slider('Precision key scale', 0.1, 0.9, 0.05, () => I.precisionScale, (v) => (I.precisionScale = v), (v) => `${Math.round(v * 100)}%`),
        check('Invert mouse Y', () => I.invertY, (v) => (I.invertY = v)),
      ),
      h('div.dim', { style: { fontSize: '13px', marginBottom: '8px' } }, 'Click a slot, then press a key, mouse button, scroll, gamepad button or push a stick (Esc cancels). Right-click a slot to clear it. Shift-click a key slot to set its strength (e.g. 40% for a gentle turn on a second key). ⚙ sets deadzone, sensitivity, curve and keyboard ramp-up per action.'),
      ...(Object.keys(ACTIONS) as Action[]).map((a) => bindRow(a, render)),
      h('div.row', { style: { marginTop: '12px' } },
        h('button.btn', { onclick: () => download('drone-keybinds.json', I) }, 'Export keybinds'),
        h('button.btn', { onclick: async () => { const t = await pickFile('.json'); if (!t) return; try { const j = JSON.parse(t); if (!j.bindings?.map) throw 0; Object.assign(I, j); saveSettings(); render(); toast('Keybinds imported'); } catch { toast('Not a keybind file', { err: true }); } } }, 'Import keybinds'),
        h('button.btn.ghost', { onclick: () => { I.bindings = PRESETS[I.preset].make(); saveSettings(); render(); } }, 'Reset to preset')),
    );
  };
  render();
  return wrap;
}

function bindRow(a: Action, rerender: () => void) {
  const I = settings.input;
  const list = (I.bindings.map[a] ??= []);
  const slot = (i: number) => {
    const b = list[i];
    const btn = h('button.btn', { title: 'Click to bind · right-click to clear · shift-click to set strength' }, describe(b));
    btn.addEventListener('click', (e) => {
      if ((e as MouseEvent).shiftKey && b && (b.dev === 'key' || b.dev === 'mouse')) {
        const v = prompt('Strength for this binding (10-100%)', String(Math.round((b.scale ?? 1) * 100)));
        if (v) { b.scale = Math.max(0.1, Math.min(1, +v / 100)); saveSettings(); rerender(); }
        return;
      }
      btn.classList.add('wait');
      btn.textContent = 'Press…';
      const ctl = getControls();
      setTimeout(() => {
        ctl.capture = (nb: Binding) => { ctl.capture = null; list[i] = nb; saveSettings(); rerender(); };
        const poll = () => { if (ctl.capture) { ctl.poll(0, 'arcade'); requestAnimationFrame(poll); } };
        poll();
      }, 150);
    });
    btn.addEventListener('contextmenu', (e) => { e.preventDefault(); list.splice(i, 1); saveSettings(); rerender(); });
    return btn;
  };
  const gear = ANALOG.includes(a) || ['boost', 'precision'].includes(a) ? h('button.btn.sm.ghost', { title: 'Options', onclick: () => actionOpts(a) }, '⚙') : null;
  return h('div.bind', null, h('div.row', null, ACTIONS[a], gear), slot(0), slot(1), slot(2));
}

function actionOpts(a: Action) {
  const o = (settings.input.bindings.opts[a] ??= {});
  const g = (k: keyof typeof DEFAULT_OPTS) => o[k] ?? DEFAULT_OPTS[k];
  modal(`${ACTIONS[a]} — options`, h('div.col', null,
    slider('Deadzone (sticks/triggers)', 0, 0.5, 0.01, () => g('deadzone'), (v) => (o.deadzone = v), (v) => v.toFixed(2)),
    slider('Sensitivity', 0.2, 2, 0.05, () => g('sens'), (v) => (o.sens = v), (v) => `${v.toFixed(2)}×`),
    slider('Response curve (1 = linear)', 1, 3, 0.1, () => g('curve'), (v) => (o.curve = v), (v) => v.toFixed(1)),
    slider('Keyboard ramp-up time', 0, 600, 10, () => g('ramp'), (v) => (o.ramp = v), (v) => (v ? `${v} ms` : 'instant')),
    h('div.dim', { style: { fontSize: '12px' } }, 'Ramp-up makes held keys build to full strength gradually — fine control for keyboard pilots.')));
}

void refresh; void swatch;
