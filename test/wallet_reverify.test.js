import { test } from 'node:test';
import assert from 'node:assert/strict';
import { walletReverifyRequired } from '../src/auth/session.js';

// The WS gateway rejects a locally-unexpired-but-server-invalid wallet session with
// a `connect_error: Wallet verification required`. The reconnect path must detect this
// from the `down` reason and force a FRESH bindWallet (instead of reusing the dead token,
// which loops forever). This guards that detection.

test('walletReverifyRequired: detects WS "Wallet verification required" connect_error', () => {
  assert.equal(walletReverifyRequired('connect_error: Wallet verification required'), true);
});

test('walletReverifyRequired: detects WALLET_NOT_VERIFIED variants (case/spacing insensitive)', () => {
  assert.equal(walletReverifyRequired('WALLET_NOT_VERIFIED'), true);
  assert.equal(walletReverifyRequired('connect_error: wallet_not_verified'), true);
  assert.equal(walletReverifyRequired('Error: wallet not verified'), true);
});

test('walletReverifyRequired: ordinary disconnects do NOT force re-verify', () => {
  assert.equal(walletReverifyRequired('transport close'), false);
  assert.equal(walletReverifyRequired('connect_error: timeout'), false);
  assert.equal(walletReverifyRequired('watchdog-idle'), false);
  assert.equal(walletReverifyRequired('ping timeout'), false);
  assert.equal(walletReverifyRequired(''), false);
  assert.equal(walletReverifyRequired(null), false);
  assert.equal(walletReverifyRequired(undefined), false);
});
