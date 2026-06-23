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
  supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
  roomId: process.env.ROOM_ID || 'farmtown-dev',
  displayName: process.env.DISPLAY_NAME || 'Farmer',
  keypair: loadKeypair(process.env.SOLANA_SECRET_KEY),
  telegram: { token: process.env.TELEGRAM_BOT_TOKEN || '', chatId: process.env.TELEGRAM_CHAT_ID || '' },
  activeHours: process.env.ACTIVE_HOURS || '06:00-23:30',
  solanaRpc: process.env.SOLANA_RPC || 'https://api.mainnet-beta.solana.com',
  withdrawAddress: process.env.WITHDRAW_ADDRESS || '',
  tile: { size: 32, originPx: 16 },
  // Cap simultaneous in-flight REST requests across the WHOLE fleet (all engines
  // share one process / one undici dispatcher). Without this, 49 farms re-binding
  // wallets at once flood the slow /api/auth/wallet/verify and every request times
  // out together. Keep low — REST is for auth/pool polls, not gameplay (socket.io).
  restMaxConcurrency: Number(process.env.REST_MAX_CONCURRENCY || 6),
  limits: { maxPendingActions: 1, minActionGapMs: 900, maxActionGapMs: 2600 },
  pool: {
    enabled: process.env.FARMER_POOL !== 'off',
    burnGold: process.env.POOL_BURN_GOLD === 'on', // default: keep gold for farming
    goldReserve: Number(process.env.POOL_GOLD_RESERVE || 100000),
    burnLevels: process.env.POOL_BURN_LEVELS === 'on', // sacrifice levels into the pool
    levelFloor: Number(process.env.POOL_LEVEL_FLOOR || 30), // server enforces minLevelAfterBurn=30
    sacrificeAt: Number(process.env.POOL_SACRIFICE_AT || 35), // sacrifice once at/above cap
  },
  sessionFile: 'data/session.json',
  multiAccount: process.env.MULTI_ACCOUNT === 'on',
  multiAccountLimit: Number(process.env.MULTI_ACCOUNT_LIMIT || 0), // 0 = run all generated subs
};
export const walletAddress = config.keypair.publicKey.toBase58();
