import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs'; import os from 'node:os'; import path from 'node:path';
import { subSessionStore, hasSubSession } from '../src/sub_sessions.js';

test('subSessionStore load/save round-trips per label, chmod 600', () => {
  const f = path.join(os.tmpdir(), `ss-${Date.now()}.json`);
  const s1 = subSessionStore('sub1', f), s2 = subSessionStore('sub2', f);
  assert.equal(s1.load(), null);
  s1.save({ access_token: 'a1', refresh_token: 'r1' });
  s2.save({ access_token: 'a2' });
  assert.equal(s1.load().access_token, 'a1');
  assert.equal(s2.load().access_token, 'a2');
  assert.equal(hasSubSession('sub1', f), true);
  assert.equal(hasSubSession('subX', f), false);
  assert.equal(fs.statSync(f).mode & 0o777, 0o600);
  s1.remove();
  assert.equal(s1.load(), null);
  assert.equal(s2.load().access_token, 'a2');
  fs.unlinkSync(f);
});
