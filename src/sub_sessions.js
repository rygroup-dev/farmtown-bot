// Per-sub-account Supabase sessions, keyed by label, in data/sub-sessions.json
// (git-ignored, chmod 600). Each sub farms under its OWN session (auto-minted via
// captcha, or pasted with /auth <label> <token>) — required because one Supabase
// session can only keep ONE wallet gameplay-authorized at a time.
import fs from 'node:fs';

const FILE = 'data/sub-sessions.json';

function readAll(file = FILE) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) || {}; } catch { return {}; }
}
function writeAll(map, file = FILE) {
  fs.writeFileSync(file, JSON.stringify(map, null, 2), { mode: 0o600 });
}

// A storage handle for one label, shaped like { load(), save(session) } so the engine
// can treat main (session.json) and subs (this map) identically.
export function subSessionStore(label, file = FILE) {
  return {
    load: () => readAll(file)[label] || null,
    save: (s) => { const m = readAll(file); m[label] = s; writeAll(m, file); },
    remove: () => { const m = readAll(file); delete m[label]; writeAll(m, file); },
  };
}

export function hasSubSession(label, file = FILE) {
  return !!readAll(file)[label];
}
