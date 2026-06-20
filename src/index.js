import { log } from './logger.js';
import { runAccount } from './core/orchestrator.js';

process.on('unhandledRejection', (e) => log.error('UNHANDLED', e?.message || String(e)));
process.on('SIGTERM', () => { log.info('SYS', 'SIGTERM'); process.exit(0); });
process.on('SIGINT', () => { log.info('SYS', 'SIGINT'); process.exit(0); });

runAccount().catch((e) => { log.error('FATAL', e.stack || e.message); process.exit(1); });
