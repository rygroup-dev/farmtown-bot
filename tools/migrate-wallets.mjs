#!/usr/bin/env node
// tools/migrate-wallets.mjs
//
// One-shot data migration for farmtown-bot (chunk 2 of fix plan).
//
// Purpose:
//   1. Strip any entry from `data/wallets.json` whose publicKey matches the main
//      wallet derived from .env `SOLANA_SECRET_KEY` (identity collision cleanup).
//   2. Re-index the remaining wallets starting at index 2 (preserves Bvzbh's
//      `sub2` label, which the orchestrator derives as `sub${w.index}`).
//   3. Strip any entry from `data/sub-sessions.json` whose key does not correspond
//      to a wallet in the cleaned `wallets.json`. Always remove `sub1` defensively.
//
// Flags:
//   --dry-run  read everything, compute the plan, print it, exit without writing
//   --force    skip confirmation prompt (default: same as --force; no prompt)
//
// Idempotency: re-running on already-clean data produces zero changes.
//
// Usage:
//   node tools/migrate-wallets.mjs [--dry-run] [--force]

import fs from 'node:fs';
import path from 'node:path';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';
import dotenv from 'dotenv';

const ROOT = process.cwd();
const ENV_PATH = path.join(ROOT, '.env');
const WALLETS_PATH = path.join(ROOT, 'data', 'wallets.json');
const SUB_SESSIONS_PATH = path.join(ROOT, 'data', 'sub-sessions.json');

// ---------- argv ----------
const argv = process.argv.slice(2);
const DRY_RUN = argv.includes('--dry-run');
const FORCE = argv.includes('--force'); // accepted for explicitness; no prompt is ever issued

// ---------- helpers ----------
function mainPubkey() {
  // dotenv: load .env into process.env (no-op if already loaded)
  dotenv.config({ path: ENV_PATH });

  const raw = process.env.SOLANA_SECRET_KEY;
  if (!raw) {
    throw new Error(`SOLANA_SECRET_KEY missing from ${ENV_PATH}`);
  }

  let bytes;
  const s = String(raw).trim();
  if (s.startsWith('[')) {
    bytes = Uint8Array.from(JSON.parse(s));
  } else {
    bytes = bs58.decode(s);
  }
  if (bytes.length !== 64) {
    throw new Error(`decoded secret key has unexpected length ${bytes.length} (expected 64)`);
  }
  return Keypair.fromSecretKey(bytes).publicKey.toBase58();
}

function short(pubkey) {
  if (!pubkey || pubkey.length < 12) return String(pubkey);
  return `${pubkey.slice(0, 8)}...${pubkey.slice(-4)}`;
}

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function ts() {
  return Date.now();
}

// ---------- run ----------
console.log('[migrate] starting');
console.log(`[migrate] mode: ${DRY_RUN ? 'DRY-RUN' : 'WRITE'}${FORCE ? ' (--force)' : ''}`);

const mainPub = mainPubkey();
console.log(`[migrate] main pubkey: ${short(mainPub)}`);

// 1. wallets.json
const walletsBefore = readJson(WALLETS_PATH);
if (!Array.isArray(walletsBefore)) {
  throw new Error(`${WALLETS_PATH} is not an array`);
}
const walletsRemovedDup = walletsBefore.filter((w) => w.publicKey !== mainPub);
const removedWalletsCount = walletsBefore.length - walletsRemovedDup.length;

// 2. re-index starting at 2 (preserves sub2 label for the first kept entry)
const walletsAfter = walletsRemovedDup.map((w, i) => ({
  index: i + 2,
  publicKey: w.publicKey,
  secretKey: w.secretKey,
}));

// 3. sub-sessions.json
const subsBefore = readJson(SUB_SESSIONS_PATH);
if (!subsBefore || typeof subsBefore !== 'object' || Array.isArray(subsBefore)) {
  throw new Error(`${SUB_SESSIONS_PATH} is not an object`);
}
const allowedKeys = new Set(walletsAfter.map((w) => `sub${w.index}`));
const subsOrphanFiltered = Object.fromEntries(
  Object.entries(subsBefore).filter(([k]) => allowedKeys.has(k)),
);
const subsAfter = { ...subsOrphanFiltered };
delete subsAfter.sub1; // defensive: never keep sub1 (was main dup historically)
const removedSubKeys = Object.keys(subsBefore).filter((k) => !(k in subsAfter));

// 4. summary
console.log(
  `[migrate] wallets: kept ${walletsAfter.length}, removed ${removedWalletsCount} ` +
  `(was ${walletsBefore.length} entries, now ${walletsAfter.length})`,
);
console.log(
  `[migrate] sub-sessions: kept ${JSON.stringify(Object.keys(subsAfter).sort())}, ` +
  `removed [${removedSubKeys.join(', ')}] ` +
  `(was ${Object.keys(subsBefore).length}, now ${Object.keys(subsAfter).length})`,
);

if (DRY_RUN) {
  console.log('[migrate] DRY-RUN: no files written, no backups created');
  console.log('[migrate] pass');
  process.exit(0);
}

// ---------- write (with backups) ----------
const stamp = ts();

const walletsBackupPath = `${WALLETS_PATH}.broken.${stamp}`;
fs.copyFileSync(WALLETS_PATH, walletsBackupPath);
console.log(`[migrate] backup: ${path.relative(ROOT, walletsBackupPath)}`);

const subsBackupPath = `${SUB_SESSIONS_PATH}.pre-clean.${stamp}`;
fs.copyFileSync(SUB_SESSIONS_PATH, subsBackupPath);
console.log(`[migrate] backup: ${path.relative(ROOT, subsBackupPath)}`);

fs.writeFileSync(WALLETS_PATH, JSON.stringify(walletsAfter, null, 2), { mode: 0o600 });
fs.writeFileSync(SUB_SESSIONS_PATH, JSON.stringify(subsAfter, null, 2), { mode: 0o600 });

console.log(`[migrate] wrote ${path.relative(ROOT, WALLETS_PATH)} (${walletsAfter.length} entries)`);
console.log(`[migrate] wrote ${path.relative(ROOT, SUB_SESSIONS_PATH)} (${Object.keys(subsAfter).length} entries)`);

// final assertion: no wallet matches main pubkey
const finalWallets = readJson(WALLETS_PATH);
const stillHasMain = finalWallets.some((w) => w.publicKey === mainPub);
if (stillHasMain) {
  throw new Error(
    `assertion failed: ${WALLETS_PATH} still contains an entry with publicKey === main pubkey`,
  );
}

console.log(`[migrate] backups: ${path.relative(ROOT, walletsBackupPath)} | ${path.relative(ROOT, subsBackupPath)}`);
console.log('[migrate] pass');
