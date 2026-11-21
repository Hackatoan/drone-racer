// Premium via Stripe Checkout (one-time purchase). Plain REST + manual webhook
// signature check, so no Stripe SDK. Inert until STRIPE_SECRET_KEY is set.
import express, { type Request, type Response, type RequestHandler } from 'express';
import { createHmac, timingSafeEqual } from 'node:crypto';
import type { Db } from './db.ts';
import type { Pilot } from './auth.ts';

const KEY = process.env.STRIPE_SECRET_KEY ?? '';
const WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET ?? '';
const PRICE_ID = process.env.STRIPE_PRICE_ID ?? ''; // optional; falls back to inline price
const PRICE_CENTS = Number(process.env.PREMIUM_PRICE_CENTS ?? 499);
const PUBLIC_URL = process.env.PUBLIC_URL ?? 'https://drone.hackatoa.com';

export const PREMIUM_PERKS = ['Upload your own drone skin textures', 'Supporter badge next to your name'];

export function premiumRoutes(db: Db, needPilot: RequestHandler) {
  const r = express.Router();

  r.get('/', needPilot, (req: Request & { pilot?: Pilot }, res) => {
    res.json({ enabled: !!KEY, premium: !!req.pilot?.premium, priceCents: PRICE_CENTS, perks: PREMIUM_PERKS });
  });

  r.post('/checkout', needPilot, async (req: Request & { pilot?: Pilot }, res) => {
    if (!KEY) return res.status(503).json({ error: 'Premium is not available yet' });
    if (req.pilot!.premium) return res.status(400).json({ error: 'already Premium' });
    const body = new URLSearchParams({
      mode: 'payment',
      success_url: `${PUBLIC_URL}/?premium=success`,
      cancel_url: `${PUBLIC_URL}/?premium=cancel`,
      client_reference_id: req.pilot!.uid,
      'metadata[uid]': req.pilot!.uid,
      'line_items[0][quantity]': '1',
    });
    if (PRICE_ID) body.set('line_items[0][price]', PRICE_ID);
    else {
      body.set('line_items[0][price_data][currency]', 'usd');
      body.set('line_items[0][price_data][unit_amount]', String(PRICE_CENTS));
      body.set('line_items[0][price_data][product_data][name]', 'Drone Racer Premium');
    }
    const sr = await fetch('https://api.stripe.com/v1/checkout/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body,
    });
    const j: any = await sr.json();
    if (!sr.ok) return res.status(502).json({ error: j?.error?.message ?? 'checkout failed' });
    res.json({ url: j.url });
  });

  return r;
}

/** Mounted before express.json() — signature verification needs the raw body. */
export function stripeWebhook(db: Db) {
  return [express.raw({ type: 'application/json', limit: '1mb' }), async (req: Request, res: Response) => {
    if (!WEBHOOK_SECRET) return res.status(503).end();
    const sig = String(req.headers['stripe-signature'] ?? '');
    const t = /t=(\d+)/.exec(sig)?.[1];
    const v1s = [...sig.matchAll(/v1=([0-9a-f]+)/g)].map((m) => m[1]);
    const payload = (req.body as Buffer).toString('utf8');
    if (!t || !v1s.length || Math.abs(Date.now() / 1000 - Number(t)) > 300) return res.status(400).end();
    const expected = createHmac('sha256', WEBHOOK_SECRET).update(`${t}.${payload}`).digest();
    if (!v1s.some((v) => { const b = Buffer.from(v, 'hex'); return b.length === expected.length && timingSafeEqual(b, expected); })) return res.status(400).end();
    const evt = JSON.parse(payload);
    if (evt.type === 'checkout.session.completed' && evt.data?.object?.payment_status === 'paid') {
      const s = evt.data.object;
      const uid = s.metadata?.uid ?? s.client_reference_id;
      if (uid) {
        await db.query('insert into drone_payments (session_id, uid, amount) values ($1,$2,$3) on conflict do nothing', [s.id, uid, s.amount_total ?? 0]);
        await db.query('update drone_pilots set premium = true where uid = $1', [uid]);
      }
    }
    res.json({ received: true });
  }] as const;
}
