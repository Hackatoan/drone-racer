// Firebase Auth ID-token verification without firebase-admin: check the JWT
// against Google's published securetoken keys. Tiny, and no service account.
import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { Request } from 'express';
import type { Db } from './db.ts';

const PROJECT = process.env.FIREBASE_PROJECT_ID ?? '';
const DEV = process.env.AUTH_DEV === '1';
const JWKS = createRemoteJWKSet(new URL('https://www.googleapis.com/service_accounts/v1/jwk/securetoken@system.gserviceaccount.com'));
const ADMINS = new Set((process.env.ADMIN_UIDS ?? '').split(',').map((s) => s.trim()).filter(Boolean));

export interface Identity { uid: string; email?: string }
export interface Pilot { uid: string; name: string; premium: boolean; admin: boolean }

export async function verifyToken(token: string | null | undefined): Promise<Identity | null> {
  if (!token) return null;
  if (DEV && token.startsWith('dev:')) return { uid: token.slice(4, 40).replace(/[^a-zA-Z0-9_-]/g, '') || 'dev' };
  if (!PROJECT) return null;
  try {
    const { payload } = await jwtVerify(token, JWKS, { issuer: `https://securetoken.google.com/${PROJECT}`, audience: PROJECT });
    if (typeof payload.sub !== 'string' || !payload.sub) return null;
    return { uid: payload.sub, email: typeof payload.email === 'string' ? payload.email : undefined };
  } catch {
    return null;
  }
}

export async function pilotFor(db: Db, uid: string): Promise<Pilot | null> {
  const { rows } = await db.query<{ name: string; premium: boolean; banned: boolean }>('select name, premium, banned from drone_pilots where uid = $1', [uid]);
  const r = rows[0];
  if (!r || r.banned) return null;
  return { uid, name: r.name, premium: r.premium, admin: ADMINS.has(uid) };
}

export const isAdminUid = (uid: string) => ADMINS.has(uid);

export const NAME_RE = /^[A-Za-z0-9_-]{3,16}$/;

/** Express helper: resolve the bearer token to an identity (and pilot, if registered). */
export async function authOf(db: Db, req: Request): Promise<{ id: Identity | null; pilot: Pilot | null }> {
  const h = req.headers.authorization;
  const id = await verifyToken(h?.startsWith('Bearer ') ? h.slice(7) : null);
  if (!id) return { id: null, pilot: null };
  return { id, pilot: await pilotFor(db, id.uid) };
}

export const authConfig = () => ({ projectId: PROJECT, dev: DEV });
