import { test } from 'node:test';
import assert from 'node:assert';
import { tileToPixel, pixelToTile, walkSteps } from '../src/util/tiles.js';

test('tileToPixel centers on tile', () => {
  assert.deepStrictEqual(tileToPixel(25, 24), { x: 25*32+16, y: 24*32+16 });
});
test('pixelToTile inverts', () => {
  assert.deepStrictEqual(pixelToTile(816, 784), { x: 25, y: 24 });
});
test('walkSteps splits a move into intermediate points', () => {
  const steps = walkSteps({ x: 0, y: 0 }, { x: 96, y: 0 }, 32);
  assert.ok(steps.length >= 3);
  assert.deepStrictEqual(steps[steps.length-1], { x: 96, y: 0 });
});
