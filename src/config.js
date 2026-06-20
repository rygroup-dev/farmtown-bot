import 'dotenv/config';
import bs58 from 'bs58';
import { Keypair } from '@solana/web3.js';

function loadKeypair(sk) {
  if (!sk) throw new Error('SOLANA_SECRET_KEY missing in .env');
  const bytes = sk.trim().startsWith('[') ? Uint8Array.from(JSON.parse(sk)) : bs58.decode(sk.trim());
  return Keypair.fromSecretKey(bytes);
}

export const config = {
  apiOrigin: process.env.API_ORIGIN || 'https://play.farmtown.online',
  realtimeUrl: process.env.REALTIME_URL || 'https://realtime.farmtown.online',
  supabaseUrl: process.env.SUPABASE_URL || 'https://irarxwyrpmmxacrbvpnz.supabase.co',
  roomId: process.env.ROOM_ID || 'farmtown-dev',
  displayName: process.env.DISPLAY_NAME || 'ohmaygawd',
  keypair: loadKeypair(process.env.SOLANA_SECRET_KEY),
  telegram: { token: process.env.TELEGRAM_BOT_TOKEN || '', chatId: process.env.TELEGRAM_CHAT_ID || '' },
  activeHours: process.env.ACTIVE_HOURS || '06:00-23:30',
  tile: { size: 32, originPx: 16 },
  limits: { maxPendingActions: 1, minActionGapMs: 900, maxActionGapMs: 2600 },
  sessionFile: 'data/session.json',
};
export const walletAddress = config.keypair.publicKey.toBase58();
