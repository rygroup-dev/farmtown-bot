// Optional Cloudflare-Turnstile solver, so the bot can MINT its own Supabase anonymous
// sessions (no manual browser paste) — the enabler for true gas-only multi-account.
//
// Uses the standard createTask / getTaskResult JSON API shared by 2Captcha, Anti-Captcha
// and CapMonster (only the host differs — set CAPTCHA_ENDPOINT). You supply + fund the key
// (CAPTCHA_API_KEY). ~$0.001–0.003 per solve. Disabled when no key is set.
import { log } from '../logger.js';

const FARMTOWN_URL = 'https://play.farmtown.online';
const TURNSTILE_SITEKEY = '0x4AAAAAADn068lY1uOdr9LV';

async function post(url, body, timeoutMs = 30000) {
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  return r.json();
}

// Solve the FarmTown Turnstile challenge → returns the token string (or throws).
export async function solveTurnstile({
  apiKey = process.env.CAPTCHA_API_KEY,
  endpoint = process.env.CAPTCHA_ENDPOINT || 'https://api.2captcha.com',
  websiteURL = FARMTOWN_URL,
  websiteKey = TURNSTILE_SITEKEY,
  pollMs = 5000,
  maxWaitMs = 120000,
} = {}) {
  if (!apiKey) throw new Error('CAPTCHA_API_KEY not set');
  const created = await post(`${endpoint}/createTask`, {
    clientKey: apiKey,
    task: { type: 'TurnstileTaskProxyless', websiteURL, websiteKey },
  });
  if (created.errorId) throw new Error(`captcha createTask: ${created.errorCode || created.errorDescription}`);
  const taskId = created.taskId;
  const deadline = Date.now() + maxWaitMs;
  while (Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, pollMs));
    const res = await post(`${endpoint}/getTaskResult`, { clientKey: apiKey, taskId });
    if (res.errorId) throw new Error(`captcha getTaskResult: ${res.errorCode || res.errorDescription}`);
    if (res.status === 'ready') return res.solution?.token || res.solution?.gRecaptchaResponse;
  }
  throw new Error('captcha solve timed out');
}

export function captchaEnabled() {
  return !!process.env.CAPTCHA_API_KEY;
}
