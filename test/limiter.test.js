import { test } from 'node:test';
import assert from 'node:assert';
import { Limiter } from '../src/net/limiter.js';

const defer = () => { let resolve, reject; const p = new Promise((res, rej) => { resolve = res; reject = rej; }); return { p, resolve, reject }; };
const tick = () => new Promise(r => setTimeout(r, 0)); // drain all pending microtasks

test('runs tasks immediately while below the concurrency limit', async () => {
  const lim = new Limiter(2);
  const a = defer(), b = defer();
  let aStarted = false, bStarted = false;
  const pa = lim.run(() => { aStarted = true; return a.p; });
  const pb = lim.run(() => { bStarted = true; return b.p; });
  await tick(); // let microtasks flush
  assert.strictEqual(aStarted, true);
  assert.strictEqual(bStarted, true);
  a.resolve(1); b.resolve(2);
  assert.deepStrictEqual(await Promise.all([pa, pb]), [1, 2]);
});

test('never exceeds the limit — queued tasks wait until a slot frees', async () => {
  const lim = new Limiter(2);
  let active = 0, peak = 0;
  const gates = [defer(), defer(), defer(), defer()];
  const runs = gates.map((g, i) => lim.run(async () => {
    active++; peak = Math.max(peak, active);
    await g.p;
    active--;
  }));
  await tick();
  assert.strictEqual(active, 2, 'only 2 may run at once');
  gates[0].resolve(); await runs[0];          // free a slot
  await tick();
  assert.strictEqual(active, 2, 'a queued task takes the freed slot');
  gates[1].resolve(); gates[2].resolve(); gates[3].resolve();
  await Promise.all(runs);
  assert.strictEqual(peak, 2, 'concurrency peak never exceeded the limit');
});

test('releases the slot even when a task throws', async () => {
  const lim = new Limiter(1);
  await assert.rejects(lim.run(async () => { throw new Error('boom'); }), /boom/);
  // if the slot leaked, this second task would hang forever
  const result = await lim.run(async () => 'recovered');
  assert.strictEqual(result, 'recovered');
});

test('returns the task result to the caller', async () => {
  const lim = new Limiter(3);
  assert.strictEqual(await lim.run(async () => 42), 42);
});
