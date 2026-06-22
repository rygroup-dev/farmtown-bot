import { test } from 'node:test';
import assert from 'node:assert/strict';
import { supabaseRemintRequired } from '../src/auth/session.js';

// After a restart the persisted refresh_token can be dead (rotated out by the prior
// process), so refreshSupabase 400s and the WS gateway rejects the stale access token with
// `connect_error: Invalid Supabase access token`. The reconnect path must detect this from
// the `down` reason and force a fresh refresh→mint (instead of looping forever on the dead
// token). This guards that detection.

test('supabaseRemintRequired: detects WS "Invalid Supabase access token" connect_error', () => {
  assert.equal(supabaseRemintRequired('connect_error: Invalid Supabase access token'), true);
  assert.equal(supabaseRemintRequired('Invalid Supabase Access Token'), true);
});

test('supabaseRemintRequired: detects token-expiry / invalid_grant variants', () => {
  assert.equal(supabaseRemintRequired('invalid_grant'), true);
  assert.equal(supabaseRemintRequired('JWT expired'), true);
  assert.equal(supabaseRemintRequired('connect_error: invalid jwt'), true);
});

test('supabaseRemintRequired: ordinary disconnects do NOT force a re-mint', () => {
  assert.equal(supabaseRemintRequired('transport close'), false);
  assert.equal(supabaseRemintRequired('connect_error: timeout'), false);
  assert.equal(supabaseRemintRequired('Wallet verification required'), false);
  assert.equal(supabaseRemintRequired('watchdog-idle'), false);
  assert.equal(supabaseRemintRequired(''), false);
  assert.equal(supabaseRemintRequired(null), false);
  assert.equal(supabaseRemintRequired(undefined), false);
});
