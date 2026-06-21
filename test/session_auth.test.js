import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseSupabaseSession, walletSessionExpiringSoon, walletSessionExpMs } from '../src/auth/session.js';

// A real-shaped (fake) JWT access token: header.payload.sig with a future exp.
function fakeJwt(expSec) {
  const b = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  return `${b({ alg: 'HS256' })}.${b({ exp: expSec })}.sig`;
}

test('parseSupabaseSession: full localStorage JSON object', () => {
  const at = fakeJwt(9999999999);
  const r = parseSupabaseSession(JSON.stringify({ access_token: at, refresh_token: 'r-tok', token_type: 'bearer' }));
  assert.equal(r.access_token, at);
  assert.equal(r.refresh_token, 'r-tok');
});

test('parseSupabaseSession: currentSession wrapper', () => {
  const r = parseSupabaseSession(JSON.stringify({ currentSession: { access_token: 'a', refresh_token: 'b' } }));
  assert.deepEqual(r, { access_token: 'a', refresh_token: 'b' });
});

test('parseSupabaseSession: array form [access, refresh]', () => {
  const r = parseSupabaseSession(JSON.stringify(['a-tok', 'r-tok', 'x']));
  assert.deepEqual(r, { access_token: 'a-tok', refresh_token: 'r-tok' });
});

test('parseSupabaseSession: bare JWT string (no refresh)', () => {
  const at = fakeJwt(9999999999);
  const r = parseSupabaseSession('  ' + at + '  ');
  assert.equal(r.access_token, at);
  assert.equal(r.refresh_token, undefined);
});

test('parseSupabaseSession: garbage → empty', () => {
  assert.deepEqual(parseSupabaseSession('hello world'), {});
  assert.deepEqual(parseSupabaseSession(''), {});
  assert.deepEqual(parseSupabaseSession(null), {});
});

test('walletSessionExpMs: reads ms exp from payload.signature token', () => {
  const exp = Date.now() + 1800000;
  const payload = Buffer.from(JSON.stringify({ v: 1, playerId: 'p', exp })).toString('base64url');
  const token = `${payload}.deadbeefsig`;
  assert.equal(walletSessionExpMs(token), exp);
});

test('walletSessionExpiringSoon: fresh token (30m) is NOT expiring; old/absent IS', () => {
  const fresh = `${Buffer.from(JSON.stringify({ exp: Date.now() + 1800000 })).toString('base64url')}.s`;
  const stale = `${Buffer.from(JSON.stringify({ exp: Date.now() + 60000 })).toString('base64url')}.s`;
  assert.equal(walletSessionExpiringSoon({ walletSessionToken: fresh }), false);
  assert.equal(walletSessionExpiringSoon({ walletSessionToken: stale }), true); // <5m skew
  assert.equal(walletSessionExpiringSoon({ walletSessionToken: '' }), true);
  assert.equal(walletSessionExpiringSoon({}), true);
});
