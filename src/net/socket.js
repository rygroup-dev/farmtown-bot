import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';
import { config } from '../config.js';
import { log } from '../logger.js';

export class GameSocket extends EventEmitter {
  constructor({ accessToken, walletSessionToken, displayName, persistentPlayerId }) {
    super();
    this.accessToken = accessToken;
    this.walletSessionToken = walletSessionToken;
    this.displayName = displayName;
    this.persistentPlayerId = persistentPlayerId;
    this.ready = false;
    this.pingTimer = null;
  }

  connect() {
    // reconnection handled by the orchestrator so every reconnect uses FRESH
    // tokens (supabase access_token ~1h, walletSessionToken ~30m both expire).
    this.socket = io(config.realtimeUrl, {
      transports: ['websocket'],
      reconnection: false,
      auth: {
        accessToken: this.accessToken,
        walletSessionToken: this.walletSessionToken,
        displayName: this.displayName,
      },
    });

    this.socket.on('connect', () => {
      log.info('WS', 'connected ' + this.socket.id);
      this.startPing();
    });

    this.socket.on('queue:update', (d) => this.emit('queue', d));

    this.socket.on('queue:ready', (d) => {
      log.info('WS', 'queue ready');
      this.join();
      this.emit('queueReady', d);
    });

    this.socket.on('roomJoined', (d) => {
      this.ready = true;
      this.emit('joined', d);
    });

    this.socket.on('pong', (d) => this.emit('pong', d));

    this.socket.on('disconnect', (r) => {
      this.ready = false;
      this.stopPing();
      log.warn('WS', 'disconnect ' + r);
      this.emit('down', r);
    });

    this.socket.on('connect_error', (e) => {
      log.warn('WS', 'connect_error ' + e.message);
      this.ready = false;
      this.stopPing();
      this.emit('down', 'connect_error: ' + e.message);
    });

    this.socket.onAny((event, ...args) =>
      this.emit('event', event, args.length === 1 ? args[0] : args),
    );

    this.socket.on('serverNotice', () => {
      if (!this.ready) this.join();
    });

    return this;
  }

  join() {
    this.socket.emit('farm:join', {
      roomId: config.roomId,
      name: this.displayName,
      persistentPlayerId: this.persistentPlayerId,
      accessToken: this.accessToken,
      walletSessionToken: this.walletSessionToken, // required since the 2026-06 update
    });
    this.socket.emit('farm:snapshot:request');
  }

  refreshSnapshot() {
    try { this.socket?.emit('farm:snapshot:request'); } catch {}
  }

  startPing() {
    this.stopPing();
    this.pingTimer = setInterval(
      () => this.socket.emit('farm:ping', { sentAt: Date.now() }),
      4000,
    );
  }

  stopPing() {
    if (this.pingTimer) clearInterval(this.pingTimer);
    this.pingTimer = null;
  }

  emitAction(event, payload) {
    this.socket.emit(event, payload);
  }

  close() {
    this.stopPing();
    this.socket?.close();
  }
}
