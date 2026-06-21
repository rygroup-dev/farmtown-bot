import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../logger.js';
import { solveTurnstile, captchaEnabled } from './captcha.js';

// Mint a BRAND-NEW anonymous Supabase session by solving the Turnstile captcha — no
// browser paste needed. Each call yields a fresh independent session (its own
// access_token + refresh_token), which is exactly what each multi-account sub needs.
// Requires CAPTCHA_API_KEY. Returns a session object ready to bind a wallet to.
export async function mintSession(rest) {
  if (!captchaEnabled()) throw new Error('CAPTCHA_API_KEY not set — cannot auto-mint sessions');
  const captcha_token = await solveTurnstile();
  const r = await rest.req('/auth/v1/signup', {
    method: 'POST', base: config.supabaseUrl, apikey: config.supabaseAnonKey, retries: 0, timeoutMs: 30000,
    body: { data: {}, gotrue_meta_security: { captcha_token } },
  });
  if (r.status === 200 && r.json?.access_token) {
    log.info('SESSION', 'minted fresh anonymous session via captcha');
    return { access_token: r.json.access_token, refresh_token: r.json.refresh_token, obtainedAt: Date.now() };
  }
  throw new Error('mintSession failed: ' + (r.json?.msg || r.json?.error_code || r.status));
}

export function loadSession() {
  try { return JSON.parse(fs.readFileSync(config.sessionFile, 'utf8')); } catch { return null; }
}
export function saveSession(s) { fs.writeFileSync(config.sessionFile, JSON.stringify(s, null, 2)); }

export async function refreshSupabase(session, rest) {
  const r = await rest.req('/auth/v1/token?grant_type=refresh_token', {
    method: 'POST', base: config.supabaseUrl,
    apikey: config.supabaseAnonKey,
    body: { refresh_token: session.refresh_token },
  });
  if (r.status === 200 && r.json?.access_token) {
    session.access_token = r.json.access_token;
    session.refresh_token = r.json.refresh_token || session.refresh_token;
    session.obtainedAt = Date.now();
    saveSession(session);
    log.info('SESSION', 'Supabase token refreshed');
    return true;
  }
  log.warn('SESSION', 'refresh failed status ' + r.status);
  return false;
}
function jwtExp(token) { try { return JSON.parse(Buffer.from(token.split('.')[1], 'base64').toString('utf8')).exp * 1000; } catch { return 0; } }
export function supabaseExpiringSoon(session, skewMs = 120000) {
  return jwtExp(session.access_token) - Date.now() < skewMs;
}

// The walletSessionToken is a `payload.signature` token; payload (part 0) carries
// iat/exp in MILLISECONDS. We can reuse the existing wallet session across reconnects
// until it's near expiry — avoids re-hitting the slow /api/auth/wallet/verify endpoint
// on every reconnect (faster, more resilient to server degradation, less auth churn).
export function walletSessionExpMs(token) {
  try {
    const b64 = String(token).split('.')[0].replace(/-/g, '+').replace(/_/g, '/');
    const p = JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
    return Number(p.exp) || 0; // already ms
  } catch { return 0; }
}
export function walletSessionExpiringSoon(session, skewMs = 300000) {
  const exp = walletSessionExpMs(session?.walletSessionToken);
  return !exp || exp - Date.now() < skewMs;
}

// Parse whatever the user pastes into Telegram: the full Supabase localStorage JSON
// (`{access_token, refresh_token, ...}` or `{currentSession:{...}}`), an older array
// form `[access_token, refresh_token]`, or a bare access_token JWT. Returns
// { access_token, refresh_token? } (refresh_token optional).
export function parseSupabaseSession(raw) {
  const text = String(raw || '').trim();
  if (!text) return {};
  let obj = null;
  try { obj = JSON.parse(text); } catch { /* not JSON */ }
  if (obj) {
    if (Array.isArray(obj)) return { access_token: obj[0], refresh_token: obj[1] };
    if (obj.access_token) return { access_token: obj.access_token, refresh_token: obj.refresh_token };
    if (obj.currentSession?.access_token) return { access_token: obj.currentSession.access_token, refresh_token: obj.currentSession.refresh_token };
    if (obj.session?.access_token) return { access_token: obj.session.access_token, refresh_token: obj.session.refresh_token };
  }
  // A bare JWT (access_token only — refresh will be missing, but works until exp).
  if (/^eyJ[\w-]+\.[\w-]+\.[\w-]+$/.test(text)) return { access_token: text };
  return {};
}
export async function keepWalletSessionAlive(rest) {
  const r = await rest.req('/api/auth/session');
  return r.status === 200 && r.json?.gameplayAllowed === true;
}
