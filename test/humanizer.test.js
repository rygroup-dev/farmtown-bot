import { test } from 'node:test';
import assert from 'node:assert';
import { gaussianDelay, walkDurationMs, withinActiveHours } from '../src/safety/humanizer.js';

test('gaussianDelay stays within [min,max]', () => {
  for (let i=0;i<500;i++){ const d = gaussianDelay(800, 2000); assert.ok(d>=800 && d<=2000); }
});
test('walkDurationMs scales with distance', () => {
  assert.ok(walkDurationMs(0) < walkDurationMs(320));
});
test('withinActiveHours respects range', () => {
  assert.strictEqual(withinActiveHours('06:00-23:30', new Date('2026-06-20T10:00:00')), true);
  assert.strictEqual(withinActiveHours('06:00-23:30', new Date('2026-06-20T03:00:00')), false);
});
