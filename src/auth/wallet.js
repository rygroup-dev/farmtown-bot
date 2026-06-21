import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { config, walletAddress } from '../config.js';

export function signMessage(message) {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), config.keypair.secretKey);
  return bs58.encode(sig);
}
export async function bindWallet(rest) {
  // A wallet challenge is SINGLE-USE: never let rest.req auto-retry these POSTs.
  // If verify's response times out the server may have already consumed the
  // challenge — retrying would hit CHALLENGE_ALREADY_USED. Instead the caller
  // retries the WHOLE bindWallet (fresh challenge each time). retries:0 + longer
  // timeout because the API can be slow right after maintenance.
  const ch = await rest.req('/api/auth/wallet/challenge', { method: 'POST', body: { walletAddress }, retries: 0, timeoutMs: 25000 });
  if (ch.status !== 200 || !ch.json?.message) throw new Error('challenge failed: ' + ch.status);
  const { challengeId, nonce, message } = ch.json;
  const signature = signMessage(message);
  const vr = await rest.req('/api/auth/wallet/verify', { method: 'POST', retries: 0, timeoutMs: 25000,
    body: { challengeId, nonce, walletAddress, message, signature } });
  if (vr.status !== 200 || !vr.json?.gameplayAllowed) throw new Error('verify failed: ' + JSON.stringify(vr.json).slice(0, 200));
  return vr.json;
}

// The walletSessionToken is a base64url JWT-like token whose payload carries the game playerId.
export function walletSessionPlayerId(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8')).playerId || null;
  } catch { return null; }
}
