import { Rest } from '../src/net/rest.js';
import { loadSession } from '../src/auth/session.js';
import { bindWallet } from '../src/auth/wallet.js';
import { GameSocket } from '../src/net/socket.js';
import { config } from '../src/config.js';
import crypto from 'node:crypto';

const rest = new Rest();
const session = loadSession();
if (session?.cookieHeader) rest.setCookie(session.cookieHeader);
rest.setBearer(session.access_token);
await bindWallet(rest);

const ppid = session.persistentPlayerId || crypto.randomUUID();
const gs = new GameSocket({
  accessToken: session.access_token,
  displayName: config.displayName,
  persistentPlayerId: ppid,
}).connect();

gs.on('queue', (d) => console.log('queue', d.position, '/', d.capacity));
gs.on('joined', (d) =>
  console.log('JOINED room', d.roomId, 'player', d.localPlayerId),
);
gs.on('event', (e) => {
  if (e === 'player:farmState/sync') console.log('GOT farmState');
});

setTimeout(() => {
  gs.close();
  process.exit(0);
}, 45000);
