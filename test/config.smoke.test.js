import { test } from 'node:test';
import assert from 'node:assert';
import { config, walletAddress } from '../src/config.js';
test('config exposes wallet + origins', () => {
  assert.ok(walletAddress.length > 30);
  assert.match(config.apiOrigin, /farmtown/);
});
