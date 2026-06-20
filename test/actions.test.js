import { test } from 'node:test';
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { ActionRunner } from '../src/game/actions.js';

function mockSocket() {
  const ev = new EventEmitter();
  ev.sent = [];
  ev.emitAction = (e, p) => { ev.sent.push([e, p]);
    setTimeout(() => ev.emit('event', 'game:actionResult', { actionId: p.actionId, ok: true }), 5); };
  return ev;
}

test('runs actions serially and waits for actionResult', async () => {
  const sock = mockSocket();
  const r = new ActionRunner(sock, { minGapMs: 0, maxGapMs: 0, walk: false });
  await r.do('tile:hoe/request', { tileX: 25, tileY: 23 }, { action: 'hoe', tool: 'hoe' });
  await r.do('tile:hoe/request', { tileX: 25, tileY: 24 }, { action: 'hoe', tool: 'hoe' });
  assert.strictEqual(sock.sent.length, 2);
  assert.match(sock.sent[0][1].actionId, /^hoe:/);
});

test('backpressure error triggers retry', async () => {
  const sock = new EventEmitter(); sock.sent = [];
  let first = true;
  sock.emitAction = (e, p) => { sock.sent.push([e, p]);
    setTimeout(() => { if (first) { first = false; sock.emit('event', 'game:error', { actionId: p.actionId, code: 'ACTION_BACKPRESSURE' }); }
      else sock.emit('event', 'game:actionResult', { actionId: p.actionId, ok: true }); }, 5); };
  const r = new ActionRunner(sock, { minGapMs: 0, maxGapMs: 0, walk: false, backoffMs: 5 });
  const ok = await r.do('tile:hoe/request', { tileX: 1, tileY: 1 }, { action: 'hoe', tool: 'hoe' });
  assert.strictEqual(ok, true);
  assert.strictEqual(sock.sent.length, 2);
});
