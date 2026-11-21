import express from 'express';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { openDb } from './db.ts';
import { apiRouter } from './api.ts';
import { stripeWebhook } from './stripe.ts';
import { initOfficial } from './maps.ts';
import { Hub } from './hub.ts';

const PORT = Number(process.env.PORT ?? 3043);

const db = await openDb();
console.log(`[db] ${db.kind}`);
initOfficial();
const hub = new Hub(db);

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Cross-Origin-Opener-Policy', 'same-origin-allow-popups'); // Firebase Google popup
  next();
});
app.get('/healthz', (_req, res) => res.json({ ok: true, online: hub.onlineCount, rooms: hub.rooms.size }));
app.post('/api/stripe/webhook', ...stripeWebhook(db));
app.use('/api', apiRouter(db, hub));

const pub = resolve(process.env.PUBLIC_DIR ?? 'dist/public');
if (existsSync(pub)) {
  app.use(express.static(pub, {
    setHeaders: (res, p) => res.setHeader('Cache-Control', /\/assets\//.test(p) ? 'public, max-age=31536000, immutable' : 'no-cache'),
  }));
  app.get(/^\/(?!api\/).*/, (_req, res) => res.sendFile(resolve(pub, 'index.html')));
}

const server = createServer(app);
const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws')) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => hub.attach(ws));
});
// drop dead sockets
setInterval(() => {
  for (const ws of wss.clients as Set<any>) {
    if (ws.isAlive === false) { ws.terminate(); continue; }
    ws.isAlive = false;
    ws.ping();
  }
}, 20_000).unref();
wss.on('connection', (ws: any) => { ws.isAlive = true; ws.on('pong', () => (ws.isAlive = true)); });
// handleUpgrade doesn't emit 'connection' on its own
const origAttach = hub.attach.bind(hub);
hub.attach = (ws) => { wss.emit('connection', ws); origAttach(ws); };

server.listen(PORT, () => console.log(`[drone-racer] listening on :${PORT}`));
