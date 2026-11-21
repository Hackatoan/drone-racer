// Firebase Auth (Google). Loaded lazily so guests never download the SDK.
// AUTH_DEV servers also accept "dev:<uid>" tokens for local testing.
import { me } from './state.ts';

type FbAuth = import('firebase/auth').Auth;
let auth: FbAuth | null = null;
let devToken: string | null = null;
let cfg: { firebase: any; devAuth: boolean; stripe: boolean } | null = null;
const listeners: (() => void)[] = [];

export const onAuth = (fn: () => void) => listeners.push(fn);
const emit = () => listeners.forEach((f) => f());

export async function initAuth() {
  cfg = await fetch('/api/config').then((r) => r.json()).catch(() => ({ firebase: null, devAuth: false, stripe: false }));
  try { devToken = cfg!.devAuth ? localStorage.getItem('drone.devToken') : null; } catch { /* ignore */ }
  if (devToken) { me.signedIn = true; emit(); }
  if (!cfg!.firebase) return;
  const { initializeApp } = await import('firebase/app');
  const fa = await import('firebase/auth');
  const app = initializeApp(cfg!.firebase);
  auth = fa.getAuth(app);
  await new Promise<void>((res) => {
    let first = true;
    fa.onAuthStateChanged(auth!, (u) => {
      me.signedIn = !!u || !!devToken;
      if (!u && !devToken) { me.uid = null; }
      emit();
      if (first) { first = false; res(); }
    });
  });
}

export const authAvailable = () => !!cfg?.firebase || !!cfg?.devAuth;
export const stripeEnabled = () => !!cfg?.stripe;

export async function signIn() {
  if (!auth && cfg?.devAuth) {
    const uid = prompt('Dev sign-in: uid') ?? '';
    if (!uid) return;
    devToken = `dev:${uid}`;
    try { localStorage.setItem('drone.devToken', devToken); } catch { /* ignore */ }
    me.signedIn = true;
    emit();
    return;
  }
  if (!auth) throw new Error('Sign-in is not configured on this server');
  const fa = await import('firebase/auth');
  await fa.signInWithPopup(auth, new fa.GoogleAuthProvider());
}

export async function signOut() {
  devToken = null;
  try { localStorage.removeItem('drone.devToken'); } catch { /* ignore */ }
  if (auth) await (await import('firebase/auth')).signOut(auth);
  me.signedIn = false; me.uid = null; me.name = null; me.premium = false; me.admin = false;
  emit();
}

export async function getToken(): Promise<string | null> {
  if (devToken) return devToken;
  return auth?.currentUser ? auth.currentUser.getIdToken() : null;
}
