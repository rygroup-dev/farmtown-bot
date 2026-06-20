import fs from 'node:fs';

const out = {};
const har = JSON.parse(fs.readFileSync('play.farmtown.online.har', 'utf8'));
const ids = new Set();
for (const e of har.log.entries) {
  const m = e.request.url.match(/assets\/crops\/([a-z_]+)\//);
  if (m && m[1] !== 'weed') ids.add(m[1]);
}

const bundle = fs.readFileSync('/root/farmtown-re/app.js', 'utf8');
for (const id of ids) {
  const re = new RegExp(`["']${id}["'][^]{0,400}`, 'g');
  const hit = bundle.match(re);
  out[id] = { id, seedId: `${id}_seed`, raw: hit ? hit[0].slice(0, 400) : null };
}

fs.mkdirSync('data', { recursive: true });
fs.writeFileSync('data/economy.raw.json', JSON.stringify(out, null, 2));
console.log('crops found:', [...ids].sort().join(', '));
console.log('wrote data/economy.raw.json — review raw windows to fill economy.json');
