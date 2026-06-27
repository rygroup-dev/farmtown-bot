import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ensureSupabaseFresh, ensureSupabaseFreshWithRetry } from '../src/core/orchestrator.js';

// The top-level ensureSupabaseFresh + ensureSupabaseFreshWithRetry split: main accounts
// throw on hard failure (no captcha, refresh dead), sub accounts return 'retry' so the
// retry wrapper can loop without throwing back into the engine. All deps injectable so
// we can simulate the captcha + refresh matrix in isolation.

const noopLog = { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} };
const baseSession = () => ({ access_token: 'a', refresh_token: 'r', obtainedAt: 0 });

test('ensureSupabaseFresh: sub-account (isMain:false) returns "retry" on refresh failure, does NOT throw', async () => {
  const session = baseSession();
  const r = await ensureSupabaseFresh({
    session,
    rest: {},
    sessionStore: { save: () => {} },
    tag: '[sub1] ',
    isMain: false,
    force: true,
    // Force the path: expiring → refresh fails → no captcha → would normally throw on main.
    supabaseExpiringSoonFn: () => true,
    refreshSupabaseFn: async () => false,
    captchaEnabledFn: () => false,
    log: noopLog,
  });
  assert.equal(r, 'retry', 'sub-account returns the retry sentinel, NOT throw');
});

test('ensureSupabaseFresh: main account (isMain:true) throws on refresh failure with no captcha', async () => {
  const session = baseSession();
  await assert.rejects(
    () => ensureSupabaseFresh({
      session,
      rest: {},
      sessionStore: { save: () => {} },
      tag: 'main ',
      isMain: true,
      force: true,
      supabaseExpiringSoonFn: () => true,
      refreshSupabaseFn: async () => false,
      captchaEnabledFn: () => false,
      log: noopLog,
    }),
    /invalid_grant.*no captcha key/i
  );
});

test('ensureSupabaseFreshWithRetry: exhausts maxAttempts and returns "retry" when refresh never succeeds', async () => {
  let calls = 0;
  const sleepCalls = [];
  const r = await ensureSupabaseFreshWithRetry({
    maxAttempts: 3,
    sleepFn: async (ms) => { sleepCalls.push(ms); },
    session: baseSession(),
    rest: {},
    sessionStore: { save: () => {} },
    tag: '[sub1] ',
    isMain: false,
    supabaseExpiringSoonFn: () => true,
    refreshSupabaseFn: async () => { calls++; return false; },
    captchaEnabledFn: () => false,
    log: noopLog,
  });
  assert.equal(r, 'retry', 'exhausted retries returns the retry sentinel');
  assert.equal(calls, 3, 'refreshSupabase called exactly maxAttempts=3 times');
  assert.equal(sleepCalls.length, 3, 'slept 30s between every retry attempt (3 sleeps for 3 attempts)');
  for (const ms of sleepCalls) assert.equal(ms, 30000, 'sleep is 30s per spec');
});

test('ensureSupabaseFreshWithRetry: returns on 2nd attempt when refreshSupabase starts succeeding', async () => {
  let calls = 0;
  const sleepCalls = [];
  const r = await ensureSupabaseFreshWithRetry({
    maxAttempts: 3,
    sleepFn: async (ms) => { sleepCalls.push(ms); },
    session: baseSession(),
    rest: {},
    sessionStore: { save: () => {} },
    tag: '[sub2] ',
    isMain: false,
    supabaseExpiringSoonFn: () => true,
    // 1st call returns false → 'retry'. 2nd call returns true → ensureSupabaseFresh returns
    // false (refresh succeeded, no need to mint), retry wrapper returns that.
    refreshSupabaseFn: async () => { calls++; return calls >= 2; },
    captchaEnabledFn: () => false,
    log: noopLog,
  });
  assert.equal(r, false, 'retry wrapper returns ensureSupabaseFresh result (false = refreshed OK, no mint)');
  assert.equal(calls, 2, 'refreshSupabase called exactly twice');
  assert.equal(sleepCalls.length, 1, 'one 30s sleep between attempt 1 (failed) and attempt 2 (succeeded)');
});

test('ensureSupabaseFresh: successful refresh saves through the provided account sessionStore', async () => {
  const session = baseSession();
  let saved = null;
  const r = await ensureSupabaseFresh({
    session,
    rest: {},
    sessionStore: { save: (s) => { saved = s; } },
    tag: '[sub2] ',
    isMain: false,
    force: true,
    supabaseExpiringSoonFn: () => true,
    refreshSupabaseFn: async (s) => {
      s.access_token = 'new-access';
      s.refresh_token = 'new-refresh';
      return true;
    },
    captchaEnabledFn: () => false,
    log: noopLog,
  });
  assert.equal(r, false);
  assert.equal(saved, session);
  assert.equal(saved.access_token, 'new-access');
  assert.equal(saved.refresh_token, 'new-refresh');
});
