export function gaussianDelay(min, max) {
  const r = (Math.random()+Math.random()+Math.random())/3;
  return Math.round(min + r*(max-min));
}

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function walkDurationMs(distancePx, speedPxPerSec = 160) {
  return Math.round((distancePx / speedPxPerSec) * 1000) + gaussianDelay(40, 180);
}

function parseHM(s){ const [h,m]=s.split(':').map(Number); return h*60+m; }

export function withinActiveHours(range, now = new Date()) {
  if (!range || range === '24h') return true;
  const [a,b] = range.split('-');
  const cur = now.getHours()*60 + now.getMinutes();
  const start = parseHM(a), end = parseHM(b);
  return start <= end ? (cur>=start && cur<=end) : (cur>=start || cur<=end);
}

export function maybeBreak(p = 0.05) { return Math.random() < p; }

// Seconds remaining in the current active window (Infinity for 24h, 0 if inactive).
// Used as a planting time-budget so the bot won't plant a crop that would ripen and
// die during its scheduled downtime.
export function secondsUntilInactive(range, now = new Date()) {
  if (!range || range === '24h') return Infinity;
  if (!withinActiveHours(range, now)) return 0;
  const end = parseHM(range.split('-')[1]);
  const cur = now.getHours() * 60 + now.getMinutes();
  let mins = end - cur;
  if (mins < 0) mins += 24 * 60;
  return Math.max(0, mins * 60 - now.getSeconds());
}
