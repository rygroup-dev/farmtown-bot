import { Rest } from '../src/net/rest.js';
import { walletAddress } from '../src/config.js';
const rest = new Rest();
console.log('Probing whether wallet/challenge works WITHOUT a Supabase session...');
const ch = await rest.req('/api/auth/wallet/challenge', { method: 'POST', body: { walletAddress } });
console.log('challenge status:', ch.status);
console.log('challenge body:', typeof ch.json === 'string' ? ch.json.slice(0, 300) : ch.json);
if (ch.status === 200 && ch.json?.nonce) console.log('=> RESULT: challenge does NOT require Supabase session — captcha can be SKIPPED.');
else console.log('=> RESULT: challenge requires a prior Supabase session — bootstrap (Playwright/Turnstile) IS needed.');
