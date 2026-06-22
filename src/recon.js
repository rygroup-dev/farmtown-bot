// recon.js — use a real session cookie to inspect the FarmTown protocol.
// Run: npm run recon   (after filling .env: FARMTOWN_COOKIE, optional FARMTOWN_BEARER)
import 'dotenv/config';
import { io } from 'socket.io-client';
import fs from 'node:fs';

const ORIGIN = process.env.API_ORIGIN || 'https://play.farmtown.online';
const RT = process.env.REALTIME_URL || 'https://realtime.farmtown.online';
const COOKIE = process.env.FARMTOWN_COOKIE || '';
let BEARER = process.env.FARMTOWN_BEARER || '';

fs.mkdirSync('captures', { recursive: true });
const log = (tag, obj) => {
  const line = `[${new Date().toISOString()}] ${tag} ${typeof obj === 'string' ? obj : JSON.stringify(obj)}`;
  console.log(line);
  fs.appendFileSync('captures/recon.log', line + '\n');
};

if (!COOKIE) { console.error('❌ Set FARMTOWN_COOKIE in .env first (copy all cookies from your browser).'); process.exit(1); }

const headers = () => {
  const h = { 'Content-Type': 'application/json', Cookie: COOKIE, Origin: ORIGIN,
    'User-Agent': 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/126 Safari/537.36' };
  if (BEARER) h.Authorization = `Bearer ${BEARER}`;
  return h;
};

async function api(path, { method = 'GET', body } = {}) {
  try {
    const r = await fetch(ORIGIN + path, { method, headers: headers(), body: body ? JSON.stringify(body) : undefined });
    const text = await r.text();
    let json; try { json = JSON.parse(text); } catch { json = text.slice(0, 300); }
    log(`REST ${method} ${path} -> ${r.status}`, json);
    return { status: r.status, json };
  } catch (e) { log(`REST ${method} ${path} ERR`, e.message); return { status: 0 }; }
}

(async () => {
  log('RECON', 'start');

  // 1) Identity & token
  const sess = await api('/api/auth/session');
  // try to auto-extract the bearer from the session if present
  const guess = sess.json?.accessToken || sess.json?.token || sess.json?.session?.access_token
    || sess.json?.walletSessionToken;
  if (!BEARER && guess) { BEARER = guess; log('AUTH', 'bearer found from /api/auth/session'); }

  await api('/api/auth/profile');
  const farms = await api('/api/farms/my');
  await api('/api/token/stars/balance');
  await api('/api/rewards/farmer-pool/status');
  const snap = await api('/api/game/snapshot');

  // roomId / farmSlug for join
  const roomId = farms.json?.farms?.[0]?.roomId || farms.json?.roomId
    || snap.json?.roomId || snap.json?.farm?.roomId;
  log('DERIVED', { roomId, bearerPresent: !!BEARER });

  // 2) Socket.io — record ALL incoming events
  const socket = io(RT, {
    transports: ['websocket'],
    extraHeaders: { Cookie: COOKIE, ...(BEARER ? { Authorization: `Bearer ${BEARER}` } : {}) },
    auth: { token: BEARER || undefined, cookie: COOKIE },
  });

  socket.onAny((event, ...args) => log(`WS<= ${event}`, args.length === 1 ? args[0] : args));
  socket.on('connect', () => {
    log('WS', `connected sid=${socket.id}`);
    // try the two known join variants
    if (roomId) {
      socket.emit('farm:join', { roomId });
      socket.emit('joinFarm', { roomId });
      socket.emit('farm:snapshot:request');
      socket.emit('farm:state/request');
    } else {
      log('WS', 'roomId not found — check the REST dump in captures/recon.log to locate the field');
    }
  });
  socket.on('connect_error', (e) => log('WS connect_error', e.message));
  socket.on('disconnect', (r) => log('WS disconnect', r));

  // close after 30 seconds
  setTimeout(() => { log('RECON', 'done — see captures/recon.log'); socket.close(); process.exit(0); }, 30000);
})();
