import { config } from '../config.js';
import { log } from '../logger.js';

const UA = 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';

export class Rest {
  constructor({ origin = config.apiOrigin } = {}) { this.origin = origin; this.cookie = ''; this.bearer = ''; this.walletSession = ''; }
  setCookie(c){ this.cookie = c; }
  setBearer(b){ this.bearer = b; }
  setWalletSession(t){ this.walletSession = t; }
  headers(extra = {}) {
    const h = { 'Content-Type': 'application/json', Origin: config.apiOrigin, 'User-Agent': UA, ...extra };
    if (this.cookie) h.Cookie = this.cookie;
    if (this.bearer) h.Authorization = `Bearer ${this.bearer}`;
    if (this.walletSession) h['x-farmtown-wallet-session'] = this.walletSession;
    return h;
  }
  async req(path, { method = 'GET', body, base, retries = 2, apikey, timeoutMs = 15000 } = {}) {
    const url = (base || this.origin) + path;
    const extra = apikey ? { apikey } : {};
    for (let i = 0; i <= retries; i++) {
      try {
        // AbortSignal.timeout prevents a hung connection (flaky server / maintenance)
        // from blocking the bot forever — the fetch rejects and we retry/back off.
        const r = await fetch(url, { method, headers: this.headers(extra), body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(timeoutMs) });
        const setC = r.headers.get('set-cookie'); if (setC) this.cookie = mergeCookie(this.cookie, setC);
        const text = await r.text(); let json; try { json = JSON.parse(text); } catch { json = text; }
        if (r.status >= 500 && i < retries) { await new Promise(s => setTimeout(s, 500 * (i + 1))); continue; }
        return { status: r.status, json };
      } catch (e) {
        log.warn('REST', `${method} ${path} err ${e.message} (try ${i})`);
        if (i === retries) return { status: 0, json: null };
        await new Promise(s => setTimeout(s, 500 * (i + 1)));
      }
    }
  }
}

function mergeCookie(jar, setCookie) {
  const pairs = Object.fromEntries((jar || '').split(';').map(s => s.trim()).filter(Boolean).map(s => { const i = s.indexOf('='); return [s.slice(0, i), s.slice(i + 1)]; }));
  for (const c of setCookie.split(/,(?=[^ ;]+=)/)) { const kv = c.split(';')[0].trim(); const i = kv.indexOf('='); if (i > 0) pairs[kv.slice(0, i)] = kv.slice(i + 1); }
  return Object.entries(pairs).map(([k, v]) => `${k}=${v}`).join('; ');
}
