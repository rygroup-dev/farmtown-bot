import { test } from 'node:test';
import assert from 'node:assert/strict';
import { solveTurnstile, captchaEnabled } from '../src/auth/captcha.js';

test('captchaEnabled reflects CAPTCHA_API_KEY presence', () => {
  const prev = process.env.CAPTCHA_API_KEY;
  delete process.env.CAPTCHA_API_KEY;
  assert.equal(captchaEnabled(), false);
  process.env.CAPTCHA_API_KEY = 'x';
  assert.equal(captchaEnabled(), true);
  if (prev === undefined) delete process.env.CAPTCHA_API_KEY; else process.env.CAPTCHA_API_KEY = prev;
});

test('solveTurnstile rejects when no API key', async () => {
  const prev = process.env.CAPTCHA_API_KEY;
  delete process.env.CAPTCHA_API_KEY;
  await assert.rejects(() => solveTurnstile({ apiKey: undefined }), /CAPTCHA_API_KEY not set/);
  if (prev !== undefined) process.env.CAPTCHA_API_KEY = prev;
});
