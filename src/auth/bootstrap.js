/**
 * One-time Playwright auth bootstrap.
 * Opens the real game site, waits for Cloudflare Turnstile to auto-solve,
 * captures the Supabase anonymous session, and persists it to data/session.json.
 *
 * DO NOT run unattended — the human operator should supervise the first launch.
 */
import fs from 'node:fs';
import { chromium } from 'playwright';
import { config } from '../config.js';
import { log } from '../logger.js';

/**
 * Extract Supabase session fields from a raw localStorage value.
 * Handles several known variants:
 *   1. base64-prefixed string  → decode then parse
 *   2. Plain JSON string       → parse directly
 *   3. Nested `{ currentSession: { access_token } }`
 *   4. Array `[ access_token, refresh_token, ... ]`
 *   5. Flat `{ access_token, refresh_token }`
 * Returns { access_token, refresh_token } or null.
 */
function extractSession(raw) {
  if (!raw || typeof raw !== 'string') return null;

  let jsonStr = raw;
  if (raw.startsWith('base64-')) {
    try {
      jsonStr = Buffer.from(raw.slice(7), 'base64').toString('utf8');
    } catch { return null; }
  }

  let parsed;
  try { parsed = JSON.parse(jsonStr); } catch { return null; }

  // Flat object: { access_token, refresh_token }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    if (parsed.access_token) {
      return { access_token: parsed.access_token, refresh_token: parsed.refresh_token };
    }
    // Nested: { currentSession: { access_token } }  (older supabase-js)
    if (parsed.currentSession?.access_token) {
      return {
        access_token: parsed.currentSession.access_token,
        refresh_token: parsed.currentSession.refresh_token,
      };
    }
    // Some builds wrap in { session: { access_token } }
    if (parsed.session?.access_token) {
      return {
        access_token: parsed.session.access_token,
        refresh_token: parsed.session.refresh_token,
      };
    }
  }

  // Array form: [ access_token, refresh_token, ... ]
  if (Array.isArray(parsed) && parsed.length >= 2 && typeof parsed[0] === 'string') {
    return { access_token: parsed[0], refresh_token: parsed[1] };
  }

  return null;
}

export async function bootstrapSession({ headless = true, timeoutMs = 90_000 } = {}) {
  const browser = await chromium.launch({ headless });
  const ctx = await browser.newContext({
    userAgent:
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    viewport: { width: 1280, height: 800 },
  });
  const page = await ctx.newPage();

  // Primary path: intercept Supabase auth network responses.
  let captured = null;

  page.on('response', async (res) => {
    const url = res.url();
    if (url.includes('/auth/v1/signup') || url.includes('/auth/v1/token')) {
      try {
        const j = await res.json();
        if (j.access_token) captured = j;
      } catch { /* non-JSON or aborted */ }
    }
  });

  log.info('BOOTSTRAP', 'opening site, waiting for Supabase session…');
  await page.goto(config.apiOrigin, { waitUntil: 'domcontentloaded', timeout: timeoutMs });

  // Poll until we get a session (network intercept or localStorage fallback).
  const deadline = Date.now() + timeoutMs;
  while (!captured && Date.now() < deadline) {
    // Fallback: read Supabase auth token from localStorage.
    const ls = await page.evaluate(() => {
      for (const k of Object.keys(localStorage)) {
        if (k.startsWith('sb-') && k.includes('auth-token')) return localStorage.getItem(k);
      }
      return null;
    });

    if (ls) {
      const parsed = extractSession(ls);
      if (parsed) captured = parsed;
    }

    if (!captured) await page.waitForTimeout(1000);
  }

  const cookies = await ctx.cookies();
  await browser.close();

  if (!captured) {
    throw new Error(
      'bootstrap failed: no Supabase session captured (Turnstile may have blocked headless — retry with headless:false once)',
    );
  }

  const session = {
    access_token: captured.access_token,
    refresh_token: captured.refresh_token,
    obtainedAt: Date.now(),
    cookieHeader: cookies
      .filter((c) => c.domain.includes('farmtown'))
      .map((c) => `${c.name}=${c.value}`)
      .join('; '),
  };

  fs.mkdirSync('data', { recursive: true });
  fs.writeFileSync(config.sessionFile, JSON.stringify(session, null, 2));
  log.info('BOOTSTRAP', 'session persisted to ' + config.sessionFile);
  return session;
}
