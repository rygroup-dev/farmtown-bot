import { test } from 'node:test';
import assert from 'node:assert';
import { actionId, moveId, intentId, clientDebug } from '../src/util/ids.js';

test('actionId has prefix and is unique', () => {
  const a = actionId('hoe'), b = actionId('hoe');
  assert.match(a, /^hoe:\d+:[a-z0-9]+$/);
  assert.notStrictEqual(a, b);
});
test('clientDebug mirrors real client shape', () => {
  const d = clientDebug({ action: 'plant', tool: 'seed_bag', seedId: 'potato_seed', tileX: 25, tileY: 24 });
  assert.strictEqual(d.interactionMode, 'farm');
  assert.strictEqual(d.networkMode, 'socket');
  assert.strictEqual(d.selectedTool, 'seed_bag');
  assert.strictEqual(d.tile, '25,24');
  assert.match(d.intent, /^intent:plant:\d+:[a-z0-9]+$/);
});
