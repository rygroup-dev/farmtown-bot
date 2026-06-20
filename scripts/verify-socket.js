import { Rest } from '../src/net/rest.js';
import { loadSession, saveSession } from '../src/auth/session.js';
import { bindWallet } from '../src/auth/wallet.js';
import { GameSocket } from '../src/net/socket.js';
import { config } from '../src/config.js';
import crypto from 'node:crypto';

function decodeJwtPayload(token) {
  try {
    const b64 = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(b64, 'base64').toString('utf8'));
  } catch { return {}; }
}

const rest = new Rest();
const session = loadSession();
if (session?.cookieHeader) rest.setCookie(session.cookieHeader);
rest.setBearer(session.access_token);

const verified = await bindWallet(rest);
const walletSessionToken = verified.walletSessionToken;
rest.setWalletSession(walletSessionToken);
const playerId = decodeJwtPayload(walletSessionToken).playerId || session.persistentPlayerId;
console.log('bind ok:', verified.gameplayAllowed, 'wallet:', verified.walletAddress, 'playerId:', playerId);

const sess = await rest.req('/api/auth/session');
console.log('session check -> walletVerified:', sess.json.walletVerified, 'gameplayAllowed:', sess.json.gameplayAllowed);

saveSession({ ...session, walletSessionToken, persistentPlayerId: playerId, cookieHeader: rest.cookie || session.cookieHeader || '' });

const ppid = playerId || crypto.randomUUID();
const gs = new GameSocket({
  accessToken: session.access_token,
  walletSessionToken,
  displayName: config.displayName,
  persistentPlayerId: ppid,
}).connect();

gs.on('queue', (d) => console.log('queue', d.position, '/', d.capacity));
gs.on('joined', (d) => console.log('JOINED room', d.roomId, 'player', d.localPlayerId));
gs.on('event', (e, data) => {
  if (e === 'player:farmState/sync') console.log('GOT farmState — gold', data?.farmState?.gold, 'level', data?.farmState?.level);
  if (e === 'game:error' || e === 'farm:error') console.log('ERR', JSON.stringify(data).slice(0, 160));
});
gs.on('down', (r) => console.log('socket down:', r));

setTimeout(() => { gs.close(); process.exit(0); }, 45000);
