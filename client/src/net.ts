// Reconnecting WebSocket with typed message fan-out.
import type { C2S, S2C } from '../../shared/protocol.ts';
import { getToken } from './auth.ts';
import { settings, me } from './state.ts';

type Handler = (m: any) => void;

class Net {
  ws: WebSocket | null = null;
  private handlers = new Map<string, Set<Handler>>();
  ping = 0;
  private pingTimer = 0;
  connected = false;
  id = '';
  private backoff = 500;
  private queue: C2S[] = [];

  connect() {
    if (this.ws && this.ws.readyState <= 1) return;
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    this.ws = ws;
    ws.onopen = async () => {
      this.backoff = 500;
      this.connected = true;
      ws.send(JSON.stringify({ t: 'hello', token: await getToken(), skin: settings.skin } satisfies C2S));
      for (const m of this.queue.splice(0)) ws.send(JSON.stringify(m));
      clearInterval(this.pingTimer);
      this.pingTimer = window.setInterval(() => this.send({ t: 'ping', c: performance.now() }), 2000);
      this.emit({ t: 'open' });
    };
    ws.onmessage = (e) => {
      let m: S2C;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'pong') this.ping = Math.round(performance.now() - m.c);
      if (m.t === 'welcome') { this.id = m.id; me.name = m.name; me.uid = m.uid; me.premium = m.premium; me.admin = m.admin; }
      this.emit(m);
    };
    ws.onclose = () => {
      this.connected = false;
      clearInterval(this.pingTimer);
      this.emit({ t: 'close' });
      setTimeout(() => this.connect(), this.backoff);
      this.backoff = Math.min(8000, this.backoff * 2);
    };
  }

  /** Re-send hello (after sign-in / skin change). */
  async rehello() {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify({ t: 'hello', token: await getToken(), skin: settings.skin }));
  }

  send(m: C2S) {
    if (this.ws?.readyState === 1) this.ws.send(JSON.stringify(m));
    else if (m.t !== 's' && m.t !== 'ping' && m.t !== 'att') this.queue.push(m);
  }

  on<T extends S2C['t'] | 'open' | 'close'>(t: T, fn: (m: Extract<S2C, { t: T }>) => void): () => void {
    let s = this.handlers.get(t);
    if (!s) this.handlers.set(t, (s = new Set()));
    s.add(fn as Handler);
    return () => s!.delete(fn as Handler);
  }

  private emit(m: { t: string }) {
    this.handlers.get(m.t)?.forEach((h) => h(m));
    this.handlers.get('*')?.forEach((h) => h(m));
  }
}

export const net = new Net();
