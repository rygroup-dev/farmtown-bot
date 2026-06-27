// Multi-account wallet manager.
//
// Account #1 ("main") is always SOLANA_SECRET_KEY from .env. Up to 1000 additional
// "sub" wallets (1001 total) are generated random keypairs, persisted to data/wallets.json
// (git-ignored, chmod 600). Every sub wallet farms its OWN profile under the SAME pasted
// Supabase session, and periodically sweeps its earned $FARM to the main wallet — so you
// only fund each sub wallet with a little SOL for gas.
import fs from 'node:fs';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import { config } from './config.js';

export const MAX_SUB_WALLETS = 1000; // + 1 main = 1001 total
const FILE = 'data/wallets.json';

export function parseSecret(sk) {
  const s = String(sk).trim();
  const bytes = s.startsWith('[') ? Uint8Array.from(JSON.parse(s)) : bs58.decode(s);
  return Keypair.fromSecretKey(bytes);
}

export function loadSubWallets(file = FILE) {
  try {
    const arr = JSON.parse(fs.readFileSync(file, 'utf8'));
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

function saveSubWallets(list, file = FILE) {
  const prev = (() => { try { return fs.statSync(file).mode; } catch { return null; } })();
  fs.writeFileSync(file, JSON.stringify(list, null, 2), { mode: 0o600 });
  if (prev == null) fs.chmodSync(file, 0o600); // ensure 600 on first create
}

// Generate up to `count` NEW sub wallets, append to the store (never exceeding the cap),
// and return the full updated list. Returns { added, total, wallets }.
// GUARDS: never accepts a generated keypair that equals the main .env wallet's publicKey
// (defensive against a 1-time identity collision that polluted the live data set). Also
// strips any pre-existing duplicate entries (legacy data) before persisting.
export function generateSubWallets(count, file = FILE) {
  const list = loadSubWallets(file);
  const room = Math.max(0, MAX_SUB_WALLETS - list.length);
  const toAdd = Math.max(0, Math.min(Number(count) || 0, room));
  const mainAddress = config.keypair.publicKey.toBase58();
  for (let i = 0; i < toAdd; i++) {
    const kp = Keypair.generate();
    if (kp.publicKey.toBase58() === mainAddress) { i--; continue; } // retry this iteration — never collide with main
    list.push({
      index: list.length + 1, // 1-based sub index (main is account #1 separately)
      publicKey: kp.publicKey.toBase58(),
      secretKey: bs58.encode(kp.secretKey),
    });
  }
  // Defensive: drop any pre-existing entry whose pubkey collides with main (legacy data).
  const before = list.length;
  const deduped = list.filter((w) => w.publicKey !== mainAddress);
  if (deduped.length !== before) list.length = 0, list.push(...deduped);
  if (toAdd > 0 || deduped.length !== before) saveSubWallets(list, file);
  return { added: toAdd, total: list.length, room: Math.max(0, room - toAdd), wallets: list };
}

// Build the full account roster: main (#1) + every stored sub wallet, each as
// { label, keypair, address, isMain }. `mainKeypair` is the .env keypair.
export function buildRoster(mainKeypair, file = FILE) {
  const roster = [{ label: 'main', keypair: mainKeypair, address: mainKeypair.publicKey.toBase58(), isMain: true }];
  for (const w of loadSubWallets(file)) {
    const kp = parseSecret(w.secretKey);
    roster.push({ label: `sub${w.index}`, keypair: kp, address: kp.publicKey.toBase58(), isMain: false });
  }
  return roster;
}
