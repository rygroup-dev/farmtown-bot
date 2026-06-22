import { test } from 'node:test';
import assert from 'node:assert';
import { Rest, restLimiter } from '../src/net/rest.js';

const tick = () => new Promise(r => setTimeout(r, 0));

test('Rest caps concurrent in-flight fetches across instances via the shared limiter', async () => {
  const realFetch = globalThis.fetch;
  const realMax = restLimiter.max;
  restLimiter.max = 2;

  let active = 0, peak = 0;
  const gates = [];
  globalThis.fetch = () => new Promise(resolve => {
    active++; peak = Math.max(peak, active);
    gates.push(() => { active--; resolve({ status: 200, headers: { get: () => null }, text: async () => '{}' }); });
  });

  try {
    // five separate engines fire a request at once; only 2 should hit fetch
    const rests = Array.from({ length: 5 }, () => new Rest());
    const calls = rests.map(r => r.req('/api/x', { retries: 0 }));
    await tick();
    assert.strictEqual(active, 2, 'only 2 fetches in flight, the rest are queued');

    while (gates.length || active > 0) { const g = gates.shift(); if (g) g(); await tick(); }
    await Promise.all(calls);
    assert.strictEqual(peak, 2, 'never exceeded the concurrency limit');
  } finally {
    globalThis.fetch = realFetch;
    restLimiter.max = realMax;
  }
});
