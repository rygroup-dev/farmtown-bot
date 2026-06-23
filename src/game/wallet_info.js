import { Connection, PublicKey, Transaction, SystemProgram, sendAndConfirmTransaction } from '@solana/web3.js';
import {
  getAssociatedTokenAddress, getAccount, getOrCreateAssociatedTokenAccount,
  createTransferInstruction,
} from '@solana/spl-token';
import { config } from '../config.js';
import { log } from '../logger.js';

const FARM_MINT = new PublicKey('yMJPZbnhoHib3ib8n8PfiVcp9yauk1vnaGKLx7epump');
const DECIMALS = 1e6;
const conn = () => new Connection(config.solanaRpc, 'confirmed');

export async function getWalletInfo(keypair = config.keypair) {
  const c = conn();
  const owner = keypair.publicKey;
  let sol = 0, farm = 0;
  try { sol = (await c.getBalance(owner)) / 1e9; } catch (e) { log.warn('WALLET', 'sol balance: ' + e.message); }
  try {
    const ata = await getAssociatedTokenAddress(FARM_MINT, owner);
    const acc = await getAccount(c, ata);
    farm = Number(acc.amount) / DECIMALS;
  } catch { /* no token account yet = 0 FARM */ }
  return { address: owner.toBase58(), sol, farm };
}

// Transfer ALL $FARM from the bot wallet to `toAddress` (your main wallet). Needs a
// little SOL in the bot wallet for fees / ATA rent. Never throws — returns a summary.
export async function withdrawFarm(toAddress, fromKeypair = config.keypair) {
  try {
    if (!toAddress) return { ok: false, reason: 'no WITHDRAW_ADDRESS set' };
    let toPub;
    try { toPub = new PublicKey(toAddress); } catch { return { ok: false, reason: 'invalid address' }; }
    const c = conn();
    const from = fromKeypair;
    const fromAta = await getAssociatedTokenAddress(FARM_MINT, from.publicKey);
    let amount;
    try { amount = (await getAccount(c, fromAta)).amount; } catch { return { ok: false, reason: 'no FARM token account / 0 balance' }; }
    if (amount === 0n) return { ok: false, reason: '0 FARM balance' };
    const toAta = await getOrCreateAssociatedTokenAccount(c, from, FARM_MINT, toPub);
    const tx = new Transaction().add(createTransferInstruction(fromAta, toAta.address, from.publicKey, amount));
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
    const fromAta = await getAssociatedTokenAddress(FARM_MINT, fromKeypair.publicKey);
    let bal;
    try { bal = (await getAccount(c, fromAta)).amount; } catch { return { ok: false, reason: 'no FARM token account / 0 balance' }; }
    if (bal < amount) return { ok: false, reason: `not enough FARM: need ${Number(amount) / DECIMALS}, have ${Number(bal) / DECIMALS}` };
    const tx = new Transaction().add(createTransferInstruction(fromAta, treasuryAta, fromKeypair.publicKey, amount));
    const sig = await sendAndConfirmTransaction(c, tx, [fromKeypair]);
    const cr = await rest.req('/api/token/stars/confirm', {
      method: 'POST', body: { quoteId: quote.quoteId, txSignature: sig }, timeoutMs: 30000,
    });
    const ok = cr.status === 200 && cr.json?.ok !== false;
    const stars = quote.totalStars;
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
    const fromAta = await getAssociatedTokenAddress(FARM_MINT, fromKeypair.publicKey);
    let bal;
    try { bal = (await getAccount(c, fromAta)).amount; } catch { return { ok: false, reason: 'no FARM account' }; }
    const baseUnits = BigInt(Math.floor(amount * DECIMALS));
    if (bal < baseUnits) return { ok: false, reason: `insufficient FARM: have ${Number(bal) / DECIMALS}, need ${amount}` };
    const toAta = await getOrCreateAssociatedTokenAccount(c, fromKeypair, FARM_MINT, toPub);
    const tx = new Transaction().add(createTransferInstruction(fromAta, toAta.address, fromKeypair.publicKey, baseUnits));
    const sig = await sendAndConfirmTransaction(c, tx, [fromKeypair]);
    log.info('WALLET', `sent ${amount} FARM to ${toAddress} sig=${sig}`);
    return { ok: true, amount, sig };
  } catch (e) {
    log.warn('WALLET', 'sendFarm failed: ' + e.message);
    return { ok: false, reason: e.message };
  }
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
