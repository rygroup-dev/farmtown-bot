import fs from 'node:fs';
import { config } from '../config.js';
import { log } from '../logger.js';

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
export async function keepWalletSessionAlive(rest) {
  const r = await rest.req('/api/auth/session');
  return r.status === 200 && r.json?.gameplayAllowed === true;
}
