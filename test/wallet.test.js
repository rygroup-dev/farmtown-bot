import { test } from 'node:test';
import assert from 'node:assert';
import nacl from 'tweetnacl';
import bs58 from 'bs58';
import { signMessage } from '../src/auth/wallet.js';
import { config } from '../src/config.js';

test('signMessage produces a valid ed25519 signature over the message', () => {
  const msg = 'FarmTown Wallet Login\nNonce: abc123';
  const sigB58 = signMessage(msg);
  const sig = bs58.decode(sigB58);
  const ok = nacl.sign.detached.verify(new TextEncoder().encode(msg), sig, config.keypair.publicKey.toBytes());
  assert.strictEqual(ok, true);
});
