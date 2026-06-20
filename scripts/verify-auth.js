import { Rest } from '../src/net/rest.js';
import { loadSession, saveSession, refreshSupabase, supabaseExpiringSoon } from '../src/auth/session.js';
import { bootstrapSession } from '../src/auth/bootstrap.js';
import { bindWallet } from '../src/auth/wallet.js';

const rest = new Rest();
let session = loadSession();
if (!session) { console.log('no session — bootstrapping'); session = await bootstrapSession(); }
else if (supabaseExpiringSoon(session)) { await refreshSupabase(session, rest); }
if (session.cookieHeader) rest.setCookie(session.cookieHeader);
rest.setBearer(session.access_token);
const verified = await bindWallet(rest);
console.log('gameplayAllowed:', verified.gameplayAllowed, 'walletSession exp:', verified.walletSessionExpiresAt);
saveSession({ ...session, walletSessionToken: verified.walletSessionToken });
