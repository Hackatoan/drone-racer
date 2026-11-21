// Screen router + global social/online state (friends, DMs, invites, rooms, tournament).
import { h, $, clear, toast, modal, fmtMs, put } from '../dom.ts';
import { me, settings, saveSettings } from '../state.ts';
import { net } from '../net.ts';
import { api, loadMap } from '../api.ts';
import { signIn, signOut, onAuth, authAvailable } from '../auth.ts';
import { Session, setFriendsDrawer, type Kind } from '../game.ts';
import type { FriendInfo, TourneyState, RoomInfo, PlayerInfo, RoomMode } from '../../../shared/protocol.ts';
import { generateArena } from '../../../shared/mapgen.ts';

export type Screen = () => HTMLElement;

export const app = {
  session: null as Session | null,
  current: null as Screen | null,
  tourney: null as TourneyState | null,
  online: 0,
  friends: [] as FriendInfo[],
  incoming: [] as string[],
  outgoing: [] as string[],
  dms: new Map<string, { mine: boolean; m: string }[]>(),
  unread: new Set<string>(),
  roomPanel: null as HTMLElement | null,
  room: null as { info: RoomInfo; players: PlayerInfo[] } | null,
  listeners: new Set<() => void>(),
};

export function refresh() { for (const f of app.listeners) f(); }

export function go(s: Screen) {
  app.current = s;
  const ui = $('#ui');
  for (const el of [...ui.children]) if (!el.classList.contains('drawer') && !el.classList.contains('modal-bg')) el.remove();
  app.listeners.clear();
  ui.prepend(s());
}

/** Re-render the current screen in place (e.g. after sign-in). */
export function rerender() { if (app.current && !app.session) go(app.current); }

// ---------------------------------------------------------------- top bar

export function topbar(title?: string, back?: () => void): HTMLElement {
  const right = h('div.row');
  const render = () => {
    clear(right);
    put(right,
      h('span.pill' + (net.connected ? '.live' : ''), null, net.connected ? `● ${app.online} online` : 'offline'),
      me.signedIn && me.uid
        ? h('button.btn.sm', { onclick: () => openFriends(false) }, `Friends${app.incoming.length || app.unread.size ? ` (${app.incoming.length + app.unread.size})` : ''}`)
        : null,
      me.signedIn
        ? h('span.row', null, h('b', null, me.name ?? '…'), me.premium ? h('span.pill', { style: { color: 'var(--gold)' } }, 'Premium') : null, h('button.btn.sm.ghost', { onclick: () => signOut().then(() => net.rehello()) }, 'Sign out'))
        : authAvailable() ? h('button.btn.sm.primary', { onclick: doSignIn }, 'Sign in with Google') : h('span.dim', null, me.name ?? 'Guest'),
    );
  };
  render();
  app.listeners.add(render);
  return h('div.topbar', { style: { marginBottom: '18px' } },
    h('div.row', null, back ? h('button.btn.sm', { onclick: back }, '← Back') : null, title ? h('h2', { style: { margin: 0 } }, title) : null),
    right);
}

export async function doSignIn() {
  try {
    await signIn();
  } catch (e) {
    toast((e as Error).message, { err: true });
  }
}

/** After auth changes: ensure a pilot name, re-identify on the socket. */
onAuth(async () => {
  if (!me.signedIn) { refresh(); return; }
  try {
    const r = await api<{ uid: string; pilot: { name: string; premium: boolean; admin: boolean } | null }>('/me');
    me.uid = r.uid;
    if (!r.pilot) await choosePilotName();
    else { me.name = r.pilot.name; me.premium = r.pilot.premium; me.admin = r.pilot.admin; }
  } catch { /* offline */ }
  await net.rehello();
  refresh();
  rerender();
});

function choosePilotName(): Promise<void> {
  return new Promise((res) => {
    const input = h('input', { type: 'text', maxLength: 16, placeholder: 'e.g. SkyRipper', style: { width: '100%' } }) as HTMLInputElement;
    const err = h('div', { style: { color: 'var(--bad)', minHeight: '20px' } });
    const close = modal('Choose your pilot name', h('div.col', null, h('div.dim', null, '3–16 letters, numbers, _ or -. This is how you appear on leaderboards and to friends.'), input, err), [
      ['Save', () => {
        api('/me/name', { body: { name: input.value.trim() } }).then((r) => { me.name = r.name; close(); res(); }).catch((e) => { err.textContent = e.message; });
        return false;
      }, 'primary'],
    ]);
    setTimeout(() => input.focus(), 50);
  });
}

// ---------------------------------------------------------------- friends drawer

let drawer: HTMLElement | null = null;
export function openFriends(invite: boolean) {
  if (drawer) { drawer.remove(); drawer = null; if (!invite) return; }
  if (!me.uid) { toast('Sign in to use friends'); return; }
  drawer = h('div.drawer');
  const body = h('div.col');
  const render = () => {
    clear(body);
    const add = h('input', { type: 'text', placeholder: 'Pilot name', maxLength: 16 }) as HTMLInputElement;
    put(body,
      h('div.row', null, h('h2', { style: { margin: 0 } }, 'Friends'), h('div.grow'), h('button.btn.sm', { onclick: () => { drawer?.remove(); drawer = null; } }, '✕')),
      h('div.row', null, add, h('button.btn.sm.primary', { onclick: () => { if (add.value.trim()) net.send({ t: 'friend', op: 'add', name: add.value.trim() }); add.value = ''; } }, 'Add')),
      app.incoming.length ? h('div', null, h('h3', null, 'Requests'), app.incoming.map((n) => h('div.friend', null, h('span.grow', null, n),
        h('button.btn.sm.primary', { onclick: () => net.send({ t: 'friend', op: 'accept', name: n }) }, 'Accept'),
        h('button.btn.sm', { onclick: () => net.send({ t: 'friend', op: 'decline', name: n }) }, 'Decline')))) : null,
      app.outgoing.length ? h('div.dim', null, `Pending: ${app.outgoing.join(', ')}`) : null,
      h('div', null, app.friends.length ? null : h('div.dim', null, 'No friends yet — add pilots by name.'),
        app.friends.map((f) => h('div.friend', null,
          h('span.dot' + (f.online ? '.on' : '')),
          h('div.grow', null, h('div', null, f.name, app.unread.has(f.name) ? h('span.pill', { style: { marginLeft: '6px', color: 'var(--accent)' } }, 'new') : null), h('div.dim', { style: { fontSize: '12px' } }, f.online ? f.activity ?? 'Online' : 'Offline')),
          app.session?.o.room && f.online ? h('button.btn.sm', { onclick: () => net.send({ t: 'invite', to: f.name }) }, 'Invite') : null,
          f.room && f.room !== app.room?.info.id ? h('button.btn.sm', { onclick: () => net.send({ t: 'join', id: f.room! }) }, 'Join') : null,
          h('button.btn.sm', { onclick: () => openDm(f.name) }, 'Message'),
          h('button.btn.sm.ghost', { title: 'Remove friend', onclick: () => confirm(`Remove ${f.name}?`) && net.send({ t: 'friend', op: 'remove', name: f.name }) }, '✕')))),
      h('div.dim', { style: { fontSize: '12px' } }, 'Play together: create a room (race, free roam or shared time trial) and invite friends, or join their public room.'),
    );
  };
  render();
  drawer.appendChild(body);
  $('#ui').appendChild(drawer);
  app.listeners.add(render);
}
setFriendsDrawer(openFriends);

async function openDm(name: string) {
  app.unread.delete(name);
  const list = h('div.msgs');
  const draw = () => {
    clear(list);
    for (const m of app.dms.get(name) ?? []) list.appendChild(h('div' + (m.mine ? '.me' : ''), null, m.m));
    list.scrollTop = list.scrollHeight;
  };
  try {
    const r = await api<{ messages: { mine: boolean; m: string }[] }>(`/dms?with=${encodeURIComponent(name)}`);
    app.dms.set(name, r.messages);
  } catch { /* show what we have */ }
  draw();
  const input = h('input', { type: 'text', maxLength: 500, placeholder: 'Message…', style: { flex: 1 } }) as HTMLInputElement;
  const send = () => { if (input.value.trim()) net.send({ t: 'dm', to: name, m: input.value.trim() }); input.value = ''; };
  input.addEventListener('keydown', (e) => { if (e.key === 'Enter') send(); e.stopPropagation(); });
  const off = net.on('dm', () => draw());
  modal(`Chat with ${name}`, h('div.col', null, list, h('div.row', null, input, h('button.btn.primary', { onclick: send }, 'Send'))), [['Close', () => { off(); }]]);
  setTimeout(() => input.focus(), 50);
}

// ---------------------------------------------------------------- global net handlers

export function bindGlobalNet(menu: Screen) {
  net.on('open', refresh);
  net.on('close', refresh);
  net.on('online', (m) => { app.online = m.n; refresh(); });
  net.on('welcome', () => refresh());
  net.on('friends', (m) => { app.friends = m.list; app.incoming = m.incoming; app.outgoing = m.outgoing; refresh(); });
  net.on('dm', (m) => {
    const other = m.from === me.name ? m.to : m.from;
    const list = app.dms.get(other) ?? [];
    list.push({ mine: m.from === me.name, m: m.m });
    app.dms.set(other, list);
    if (m.from !== me.name) { app.unread.add(other); toast(`${m.from}: ${m.m.slice(0, 80)}`, { action: ['Reply', () => openDm(other)] }); refresh(); }
  });
  net.on('invite', (m) => toast(`${m.from} invited you to ${m.room.mode === 'tt' ? 'a time trial' : m.room.mode} on ${m.room.mapName}`, { ms: 12000, action: ['Join', () => net.send({ t: 'join', id: m.room.id })] }));
  net.on('notice', (m) => toast(m.m));
  net.on('err', (m) => toast(m.m, { err: true }));
  net.on('tourney', (m) => { app.tourney = m.state; refresh(); });
  net.on('room', (m) => onRoom(m.room, m.players, menu));
  net.on('left', () => { app.room = null; closeRoomPanel(); });
}

const KIND: Record<RoomMode, Kind> = { race: 'race', freeroam: 'freeroam', pvp: 'pvp', ko: 'ko', tt: 'tt' };

async function onRoom(info: RoomInfo, players: PlayerInfo[], menu: Screen) {
  const fresh = !app.room || app.room.info.id !== info.id;
  app.room = { info, players };
  if (fresh) {
    if (app.session) { app.session.o.onExit = () => {}; app.session.exit({}); app.session = null; }
    let map, meta = null;
    try {
      if (info.mapId.startsWith('pvp:')) map = generateArena(Number(info.mapId.slice(4)));
      else { const m = await loadMap(info.mapId); map = m.map; meta = m.meta; }
    } catch { toast('Could not load the room map', { err: true }); net.send({ t: 'leave' }); return; }
    go(() => h('div.screen.clear'));
    app.session = new Session({
      kind: KIND[info.mode], mapId: info.mapId, map, meta, laps: info.mode === 'ko' ? 1 : info.laps, room: { info, players },
      onExit: () => { app.session = null; app.room = null; closeRoomPanel(); go(menu); },
    });
  }
  renderRoomPanel();
}

function closeRoomPanel() { app.roomPanel?.remove(); app.roomPanel = null; }

function renderRoomPanel() {
  const r = app.room;
  if (!r) return;
  closeRoomPanel();
  const { info, players } = r;
  const isHost = players[0] && info.host === me.name;
  const meP = players.find((p) => p.id === net.id);
  const showLobby = info.mode === 'race' && (info.phase === 'lobby' || info.phase === 'results');
  const box = h('div', { style: { position: 'absolute', left: '18px', top: '120px', width: '280px', background: 'var(--panel)', border: '1px solid var(--line)', borderRadius: '12px', padding: '12px', fontSize: '13px', pointerEvents: 'auto' } },
    h('div.row', null, h('b', null, `${info.mode === 'tt' ? 'Time trial' : info.mode.toUpperCase()} · ${info.mapName}`), h('div.grow'), h('span.pill', null, info.id)),
    h('div.dim', null, `${players.length}/${info.max} pilots${info.mode === 'race' ? ` · ${info.laps} laps · collisions ${info.collide ? 'on' : 'off'}` : ''}${info.teamSize ? ` · ${info.teamSize}v${info.teamSize}` : ''}`),
    showLobby ? h('div', { style: { margin: '8px 0' } }, players.map((p) => h('div.row', null, h('span.dot' + (p.ready ? '.on' : '')), p.name, info.host === p.name ? h('span.dim', null, '(host)') : null))) : null,
    showLobby ? h('div.row', null,
      h('button.btn.sm' + (meP?.ready ? '.on' : ''), { onclick: () => net.send({ t: 'ready', v: !meP?.ready }) }, meP?.ready ? 'Ready ✓' : 'Ready'),
      isHost ? h('button.btn.sm.primary', { onclick: () => net.send({ t: 'start' }) }, 'Start race') : h('span.dim', null, 'Host starts the race'),
    ) : null,
    showLobby && isHost ? h('div.row', { style: { marginTop: '6px' } },
      h('label.row', null, 'Laps', h('input', { type: 'number', min: 1, max: 10, value: info.laps, style: { width: '56px' }, onchange: (e: any) => net.send({ t: 'settings', opts: { laps: +e.target.value } }) })),
      h('label.row', null, h('input', { type: 'checkbox', checked: info.collide, onchange: (e: any) => net.send({ t: 'settings', opts: { collide: e.target.checked } }) }), 'Collisions'),
    ) : null,
    me.uid ? h('button.btn.sm', { style: { marginTop: '6px' }, onclick: () => openFriends(true) }, 'Invite friends') : null,
    h('button.btn.sm.ghost', { style: { marginTop: '6px', marginLeft: '6px' }, onclick: () => app.session?.exit() }, 'Leave'),
  );
  if (!showLobby && info.mode !== 'tt' && info.mode !== 'freeroam') { box.style.display = 'none'; }
  app.roomPanel = box;
  $('#ui').appendChild(box);
}

export function startRoomQuick(mode: RoomMode, teamSize: 0 | 2 | 3 | 4 = 0) {
  net.send({ t: 'quick', mode, teamSize });
}

export function tourneyLine(t: TourneyState | null): string {
  if (!t) return '';
  const mins = (ms: number) => Math.max(0, Math.ceil(ms / 60000));
  if (t.phase === 'idle') return `Next tournament in ${mins(t.nextAt - Date.now())} min · ${t.queued.length} queued (need ${t.minPlayers})`;
  if (t.phase === 'qualifying') return `Qualifying on ${t.mapName} · ${mins((t.endsAt ?? 0) - Date.now())} min left · ${t.qualifiers.length} times posted`;
  if (t.phase === 'knockout') return `Knockouts running · ${t.divisions.length} division${t.divisions.length > 1 ? 's' : ''}`;
  return `Tournament finished · winner ${t.divisions[0]?.winner ?? '—'}`;
}

export const persist = () => saveSettings();
void settings; void fmtMs;
