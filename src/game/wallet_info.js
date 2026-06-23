import fs from 'node:fs';
import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress, getAccount, getOrCreateAssociatedTokenAccount,
  createTransferInstruction, TOKEN_2022_PROGRAM_ID,
} from '@solana/spl-token';
import { config } from '../config.js';
import { log } from '../logger.js';

const PENDING_FILE = 'data/pending_stars.json';
function loadPending() { try { return JSON.parse(fs.readFileSync(PENDING_FILE, 'utf8')); } catch { return []; } }
function savePending(list) { fs.writeFileSync(PENDING_FILE, JSON.stringify(list, null, 2)); }
export function addPendingStar(entry) { const p = loadPending(); p.push({ ...entry, ts: Date.now() }); savePending(p); }
export function removePendingStar(quoteId) { savePending(loadPending().filter(e => e.quoteId !== quoteId)); }
export function getPendingStars() { return loadPending(); }

const FARM_MINT = new PublicKey('yMJPZbnhoHib3ib8n8PfiVcp9yauk1vnaGKLx7epump');
const FARM_PROGRAM = TOKEN_2022_PROGRAM_ID;
const DECIMALS = 1e6;
const conn = () => new Connection(config.solanaRpc, 'confirmed');

export async function getWalletInfo(keypair = config.keypair) {
  const c = conn();
  const owner = keypair.publicKey;
  let sol = 0, farm = 0;
  try { sol = (await c.getBalance(owner)) / 1e9; } catch (e) { log.warn('WALLET', 'sol balance: ' + e.message); }
  try {
    const ata = await getAssociatedTokenAddress(FARM_MINT, owner, false, FARM_PROGRAM);
    const acc = await getAccount(c, ata, 'confirmed', FARM_PROGRAM);
    farm = Number(acc.amount) / DECIMALS;
  } catch { /* no token account yet = 0 FARM */ }
  return { address: owner.toBase58(), sol, farm };
}

export async function withdrawFarm(toAddress, fromKeypair = config.keypair) {
  try {
    if (!toAddress) return { ok: false, reason: 'no WITHDRAW_ADDRESS set' };
    let toPub;
    try { toPub = new PublicKey(toAddress); } catch { return { ok: false, reason: 'invalid address' }; }
    const c = conn();
    const from = fromKeypair;
    const fromAta = await getAssociatedTokenAddress(FARM_MINT, from.publicKey, false, FARM_PROGRAM);
    let amount;
    try { amount = (await getAccount(c, fromAta, 'confirmed', FARM_PROGRAM)).amount; } catch { return { ok: false, reason: 'no FARM token account / 0 balance' }; }
    if (amount === 0n) return { ok: false, reason: '0 FARM balance' };
    const toAta = await getOrCreateAssociatedTokenAccount(c, from, FARM_MINT, toPub, false, 'confirmed', undefined, FARM_PROGRAM);
    const tx = new Transaction().add(createTransferInstruction(fromAta, toAta.address, from.publicKey, amount, [], FARM_PROGRAM));
    const sig = await sendAndConfirmTransaction(c, tx, [from]);
    const ui = Number(amount) / DECIMALS;
    log.info('WALLET', `withdrew ${ui} FARM to ${toAddress} sig=${sig}`);
    return { ok: true, sig, amount: ui };
  } catch (e) {
    log.warn('WALLET', 'withdraw failed: ' + e.message);
    return { ok: false, reason: e.message };
  }
}

export async function buyStars(rest, bundleId, fromKeypair = config.keypair) {
  try {
    const q = await rest.req('/api/token/stars/quote', {
      method: 'POST', body: { bundleId }, timeoutMs: 30000,
    });
    if (q.status !== 200 || !q.json?.quote) return { ok: false, reason: 'quote failed: ' + (q.json?.message || q.status) };
    const quote = q.json.quote;
    const amount = BigInt(quote.tokenAmountRequiredBaseUnits);
    const treasuryAta = new PublicKey(quote.treasuryTokenAccount);
    const c = conn();
    const fromAta = await getAssociatedTokenAddress(FARM_MINT, fromKeypair.publicKey, false, FARM_PROGRAM);
    let bal;
    try { bal = (await getAccount(c, fromAta, 'confirmed', FARM_PROGRAM)).amount; } catch { return { ok: false, reason: 'no FARM token account / 0 balance' }; }
    if (bal < amount) return { ok: false, reason: `not enough FARM: need ${Number(amount) / DECIMALS}, have ${Number(bal) / DECIMALS}` };
    const tx = new Transaction().add(createTransferInstruction(fromAta, treasuryAta, fromKeypair.publicKey, amount, [], FARM_PROGRAM));
    const sig = await sendAndConfirmTransaction(c, tx, [fromKeypair]);
    log.info('STARS', `tx sent sig=${sig} quoteId=${quote.quoteId} — confirming…`);
    let cr;
    for (let attempt = 0; attempt < 3; attempt++) {
      cr = await rest.req('/api/token/stars/confirm', {
        method: 'POST', body: { quoteId: quote.quoteId, txSignature: sig }, timeoutMs: 45000,
      });
      if (cr.status === 200 && cr.json?.ok) break;
      log.warn('STARS', `confirm attempt ${attempt}: ${cr.status} ${JSON.stringify(cr.json)}`);
      if (attempt < 2) await new Promise(r => setTimeout(r, 3000));
    }
    const ok = cr.status === 200 && cr.json?.ok === true;
    const stars = quote.totalStars;
    if (!ok) {
      addPendingStar({ quoteId: quote.quoteId, sig, bundleId, stars, wallet: fromKeypair.publicKey.toBase58() });
      log.warn('STARS', `confirm failed — saved to pending. quoteId=${quote.quoteId} sig=${sig} reason=${JSON.stringify(cr.json)}`);
    } else {
      removePendingStar(quote.quoteId);
    }
    log.info('STARS', `buy ${bundleId} ${stars}⭐ amount=${Number(amount) / DECIMALS} FARM sig=${sig} confirm=${ok}`);
    return { ok, stars, farmSpent: Number(amount) / DECIMALS, sig, confirm: cr.json };
  } catch (e) {
    log.warn('STARS', 'buyStars failed: ' + e.message);
    return { ok: false, reason: e.message };
  }
}

export async function sendFarmTo(toAddress, amount, fromKeypair = config.keypair) {
  try {
    const toPub = new PublicKey(toAddress);
    const c = conn();
    const fromAta = await getAssociatedTokenAddress(FARM_MINT, fromKeypair.publicKey, false, FARM_PROGRAM);
    let bal;
    try { bal = (await getAccount(c, fromAta, 'confirmed', FARM_PROGRAM)).amount; } catch { return { ok: false, reason: 'no FARM account' }; }
    const baseUnits = BigInt(Math.floor(amount * DECIMALS));
    if (bal < baseUnits) return { ok: false, reason: `insufficient FARM: have ${Number(bal) / DECIMALS}, need ${amount}` };
    const toAta = await getOrCreateAssociatedTokenAccount(c, fromKeypair, FARM_MINT, toPub, false, 'confirmed', undefined, FARM_PROGRAM);
    const tx = new Transaction().add(createTransferInstruction(fromAta, toAta.address, fromKeypair.publicKey, baseUnits, [], FARM_PROGRAM));
    const sig = await sendAndConfirmTransaction(c, tx, [fromKeypair]);
    log.info('WALLET', `sent ${amount} FARM to ${toAddress} sig=${sig}`);
    return { ok: true, amount, sig };
  } catch (e) {
    log.warn('WALLET', `sendFarm to ${toAddress} failed: ${e.message || e}`);
    return { ok: false, reason: e.message || String(e) || 'unknown error' };
  }
}

export async function retryPendingStar(rest, entry) {
  try {
    const cr = await rest.req('/api/token/stars/confirm', {
      method: 'POST', body: { quoteId: entry.quoteId, txSignature: entry.sig }, timeoutMs: 45000,
    });
    if (cr.status === 200 && cr.json?.ok) {
      removePendingStar(entry.quoteId);
      log.info('STARS', `retry confirm OK quoteId=${entry.quoteId}`);
      return { ok: true, stars: entry.stars, confirm: cr.json };
    }
    log.warn('STARS', `retry confirm failed: ${JSON.stringify(cr.json)}`);
    return { ok: false, reason: cr.json?.message || cr.status };
  } catch (e) { return { ok: false, reason: e.message }; }
}

export async function sendSolTo(toAddress, lamports, fromKeypair = config.keypair) {
  try {
    const toPub = new PublicKey(toAddress);
    const c = conn();
    const tx = new Transaction().add(SystemProgram.transfer({ fromPubkey: fromKeypair.publicKey, toPubkey: toPub, lamports: BigInt(lamports) }));
    const sig = await sendAndConfirmTransaction(c, tx, [fromKeypair]);
    const sol = Number(lamports) / 1e9;
    log.info('WALLET', `sent ${sol} SOL to ${toAddress} sig=${sig}`);
    return { ok: true, sol, sig };
  } catch (e) {
    log.warn('WALLET', 'sendSol failed: ' + e.message);
    return { ok: false, reason: e.message };
  }
}
