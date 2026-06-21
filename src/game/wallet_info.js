// On-chain wallet helpers for the Telegram /wallet panel.
// Withdrawal = move earned $FARM out of the bot's wallet to your main wallet.
// Deposit = buy Stars with $FARM (handled in-game via stars/quote+confirm — info only here).
import { Connection, PublicKey, Transaction, sendAndConfirmTransaction } from '@solana/web3.js';
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
