import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { config, walletAddress } from '../config.js';

export function signMessage(message) {
  const sig = nacl.sign.detached(new TextEncoder().encode(message), config.keypair.secretKey);
  return bs58.encode(sig);
}
export async function bindWallet(rest) {
  const ch = await rest.req('/api/auth/wallet/challenge', { method: 'POST', body: { walletAddress } });
  if (ch.status !== 200 || !ch.json?.message) throw new Error('challenge failed: ' + ch.status);
  const { challengeId, nonce, message } = ch.json;
  const signature = signMessage(message);
  const vr = await rest.req('/api/auth/wallet/verify', { method: 'POST',
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
