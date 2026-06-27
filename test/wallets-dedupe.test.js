import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { generateSubWallets, loadSubWallets } from '../src/wallets.js';
import { config } from '../src/config.js';

// Regression test for the dedupe guard in generateSubWallets: a 1-time identity collision
// between a generated keypair and the main .env wallet polluted the live data set. The
// guard (a) never writes a new entry whose pubkey equals main's, and (b) strips any
// pre-existing entry that already collides (legacy data) on the next generateSubWallets call.

const mainPubkey = config.keypair.publicKey.toBase58();
const tmpFile = (suffix) => path.join(os.tmpdir(), `wallets-dedupe-${suffix}-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

test('pre-seeded duplicate-of-main entry is filtered out by generateSubWallets dedupe pass', () => {
  const f = tmpFile('A');
  try {
    // Pre-seed the file with a forged main-duplicate entry + a legit one. We forge the
    // duplicate: loadSubWallets doesn't decode the secretKey, so an invalid value is OK.
    const legit = Keypair.generate();
    const seed = [
      { index: 1, publicKey: mainPubkey, secretKey: 'forged-main-dup' },
      { index: 2, publicKey: legit.publicKey.toBase58(), secretKey: 'forged-legit' },
    ];
    fs.writeFileSync(f, JSON.stringify(seed, null, 2), { mode: 0o600 });

    // loadSubWallets alone is a thin read — it does NOT filter. The dedupe pass lives in
    // generateSubWallets (executed on every call). Calling it with 0 new wallets triggers
    // the dedupe + persists the cleaned list, without adding any new entries.
    const beforeClean = loadSubWallets(f);
    assert.equal(beforeClean.length, 2, 'pre-seed loaded both entries');

    const r = generateSubWallets(0, f);
    assert.equal(r.added, 0, 'no new wallets added');
    assert.equal(r.total, 1, 'only the legit entry survives');

    const after = loadSubWallets(f);
    assert.equal(after.length, 1, 'persisted list has the duplicate removed');
    assert.notEqual(after[0].publicKey, mainPubkey, 'main pubkey is gone from the file');
    assert.equal(after[0].publicKey, legit.publicKey.toBase58(), 'legit entry preserved');
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
});

test('10× generateSubWallets(5) never produces an entry whose publicKey equals mainPubkey', () => {
  const f = tmpFile('B');
  try {
    for (let call = 0; call < 10; call++) {
      const r = generateSubWallets(5, f);
      // First call adds 5; subsequent calls add 5 each up to MAX_SUB_WALLETS.
      assert.ok(r.total > 0);
      for (const w of r.wallets) {
        assert.notEqual(w.publicKey, mainPubkey, `entry on call ${call} collided with main: ${w.publicKey}`);
      }
    }
    const persisted = loadSubWallets(f);
    // 10 calls × 5 = 50 sub wallets (well under MAX_SUB_WALLETS=1000).
    assert.equal(persisted.length, 50);
    for (const w of persisted) {
      assert.notEqual(w.publicKey, mainPubkey, `persisted entry collided with main: ${w.publicKey}`);
    }
  } finally {
    try { fs.unlinkSync(f); } catch {}
  }
});
