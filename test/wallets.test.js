import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Keypair } from '@solana/web3.js';
import { generateSubWallets, loadSubWallets, buildRoster, parseSecret, MAX_SUB_WALLETS } from '../src/wallets.js';

const tmp = () => path.join(os.tmpdir(), `ftw-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);

test('generates sub wallets, persists, and caps at 49', () => {
  const f = tmp();
  let r = generateSubWallets(3, f);
  assert.equal(r.added, 3); assert.equal(r.total, 3);
  assert.equal(loadSubWallets(f).length, 3);
  // append more
  r = generateSubWallets(2, f);
  assert.equal(r.total, 5);
  // cap at 49 — asking for 100 only adds the remaining 44
  r = generateSubWallets(100, f);
  assert.equal(r.total, MAX_SUB_WALLETS);
  assert.equal(r.added, MAX_SUB_WALLETS - 5);
  // file is chmod 600
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  fs.unlinkSync(f);
});

test('stored sub wallets are valid, unique keypairs', () => {
  const f = tmp();
  generateSubWallets(4, f);
  const subs = loadSubWallets(f);
  const addrs = new Set();
  for (const w of subs) {
    const kp = parseSecret(w.secretKey);
    assert.equal(kp.publicKey.toBase58(), w.publicKey);
    addrs.add(w.publicKey);
  }
  assert.equal(addrs.size, 4, 'all unique');
  fs.unlinkSync(f);
});

test('buildRoster puts main first then subs', () => {
  const f = tmp();
  generateSubWallets(2, f);
  const main = Keypair.generate();
  const roster = buildRoster(main, f);
  assert.equal(roster.length, 3);
  assert.equal(roster[0].isMain, true);
  assert.equal(roster[0].address, main.publicKey.toBase58());
  assert.equal(roster[1].isMain, false);
  assert.equal(roster[1].label, 'sub1');
  fs.unlinkSync(f);
});

test('missing store → empty list, roster is just main', () => {
  assert.deepEqual(loadSubWallets('/nonexistent/xyz.json'), []);
  const main = Keypair.generate();
  assert.equal(buildRoster(main, '/nonexistent/xyz.json').length, 1);
});
