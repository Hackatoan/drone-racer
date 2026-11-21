import { initRenderer } from './game.ts';
import { initAuth } from './auth.ts';
import { net } from './net.ts';
import { settings } from './state.ts';
import { setTexturePolicy } from './textures.ts';
import { go, bindGlobalNet } from './ui/app.ts';
import { menu, mapDetail } from './ui/screens.ts';
import { toast } from './dom.ts';

setTexturePolicy(settings.textures);
try {
  initRenderer();
} catch {
  document.body.innerHTML = '<div style="padding:40px;font:16px system-ui;color:#e8ecf3">Drone Racer needs WebGL. Enable hardware acceleration in your browser settings, or try another browser.</div>';
  throw new Error('no webgl');
}
bindGlobalNet(menu);
await initAuth();
net.connect();

const q = new URLSearchParams(location.search);
if (q.get('premium') === 'success') toast('Payment received — Premium unlocks within a few seconds. Thanks for supporting the game!', { ms: 9000 });
history.replaceState(null, '', location.pathname);
const mapParam = q.get('map');
go(mapParam ? () => mapDetail(mapParam, 'tt', menu) : menu);

if (import.meta.env.DEV) {
  // e2e helpers: window.__dev.pilot() returns a per-tick autopilot for the current session
  const { makePilot } = await import('../../shared/mapgen.ts');
  const { app } = await import('./ui/app.ts');
  (window as any).__dev = { pilot: () => { const s = app.session!; return makePilot(s.world, s.sim); }, app };
}
