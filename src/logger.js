import fs from 'node:fs';
const LOG = 'data/bot.log';
fs.mkdirSync('data', { recursive: true });
const ts = () => new Date().toISOString();
function write(level, tag, msg) {
  const line = `[${ts()}] ${level} ${tag} ${typeof msg === 'string' ? msg : JSON.stringify(msg)}`;
  console.log(line);
  try { fs.appendFileSync(LOG, line + '\n'); } catch {}
}
export const log = {
  info: (tag, m) => write('INFO ', tag, m),
  warn: (tag, m) => write('WARN ', tag, m),
  error: (tag, m) => write('ERROR', tag, m),
  debug: (tag, m) => { if (process.env.DEBUG) write('DEBUG', tag, m); },
};
