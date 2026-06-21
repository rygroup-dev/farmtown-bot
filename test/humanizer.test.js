import { test } from 'node:test';
import assert from 'node:assert';
import { gaussianDelay, walkDurationMs, withinActiveHours, secondsUntilInactive } from '../src/safety/humanizer.js';

test('secondsUntilInactive: 24h Infinity, inactive 0, active counts down to window end', () => {
  assert.strictEqual(secondsUntilInactive('24h'), Infinity);
  assert.strictEqual(secondsUntilInactive('06:00-23:30', new Date('2026-06-20T03:00:00')), 0);
  const s = secondsUntilInactive('06:00-23:30', new Date('2026-06-20T23:00:00'));
  assert.ok(s > 29 * 60 && s <= 30 * 60);
});

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
