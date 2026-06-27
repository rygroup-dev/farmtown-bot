import { test } from 'node:test';
import assert from 'node:assert/strict';
import { proactiveWalletRefresh } from '../src/core/orchestrator.js';

// `proactiveWalletRefresh` keeps the walletSessionToken fresh on the keepalive loop so
// the slow /api/auth/wallet/verify is only hit when the token is actually within its
// expiry window. All deps are injectable so this test exercises the function without
// the real network.

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };

test('proactiveWalletRefresh: expiringSoon=false → no bind, no save, returns renewed:false', async () => {
  let bindCalls = 0;
  let saveCalls = 0;
  const session = { walletSessionToken: 'old-token' };
  const r = await proactiveWalletRefresh({
    session,
    rest: {},
    keypair: {},
    sessionStore: { save: () => { saveCalls++; } },
    tag: 'main ',
    bindWalletFn: async () => { bindCalls++; return { walletSessionToken: 'new-token' }; },
    expiringSoonFn: () => false,
    log: noopLog,
  });
  assert.equal(r.renewed, false);
  assert.equal(bindCalls, 0, 'bindWallet must NOT be called when not expiring');
  assert.equal(saveCalls, 0, 'sessionStore.save must NOT be called when not renewing');
  assert.equal(session.walletSessionToken, 'old-token', 'session unchanged');
});

test('proactiveWalletRefresh: expiringSoon=true → bind once, save once, returns renewed:true', async () => {
  let bindCalls = 0;
  let saveCalls = 0;
  let savedSession = null;
  const session = { walletSessionToken: 'old-token' };
  const r = await proactiveWalletRefresh({
    session,
    rest: {},
    keypair: { pub: 'kp' },
    sessionStore: { save: (s) => { saveCalls++; savedSession = s; } },
    tag: '[sub1] ',
    bindWalletFn: async () => { bindCalls++; return { walletSessionToken: 'fresh-token' }; },
    expiringSoonFn: () => true,
    log: noopLog,
  });
  assert.equal(r.renewed, true);
  assert.equal(bindCalls, 1, 'bindWallet called exactly once');
  assert.equal(saveCalls, 1, 'sessionStore.save called exactly once');
  assert.equal(savedSession, session, 'save receives the (mutated) session object');
  assert.equal(session.walletSessionToken, 'fresh-token', 'session updated with new token');
});

test('proactiveWalletRefresh: bindWallet throws → returns renewed:false + error, no save', async () => {
  let bindCalls = 0;
  let saveCalls = 0;
  const session = { walletSessionToken: 'old-token' };
  const r = await proactiveWalletRefresh({
    session,
    rest: {},
    keypair: {},
    sessionStore: { save: () => { saveCalls++; } },
    tag: 'main ',
    bindWalletFn: async () => { bindCalls++; throw new Error('verify failed: timeout'); },
    expiringSoonFn: () => true,
    log: noopLog,
  });
  assert.equal(r.renewed, false);
  assert.equal(r.error, 'verify failed: timeout', 'error message surfaced');
  assert.equal(bindCalls, 1, 'bindWallet was attempted');
  assert.equal(saveCalls, 0, 'sessionStore.save MUST NOT be called when bind throws');
  assert.equal(session.walletSessionToken, 'old-token', 'session token unchanged on failure');
});
