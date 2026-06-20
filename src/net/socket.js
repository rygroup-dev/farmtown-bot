import { EventEmitter } from 'node:events';
import { io } from 'socket.io-client';
import { config } from '../config.js';
import { log } from '../logger.js';

export class GameSocket extends EventEmitter {
  constructor({ accessToken, displayName, persistentPlayerId }) {
    super();
    this.accessToken = accessToken;
    this.displayName = displayName;
    this.persistentPlayerId = persistentPlayerId;
    this.ready = false;
    this.pingTimer = null;
  }

  connect() {
    this.socket = io(config.realtimeUrl, {
      transports: ['websocket'],
      reconnection: true,
      reconnectionDelay: 1500,
      reconnectionDelayMax: 15000,
      randomizationFactor: 0.5,
      extraHeaders: { Authorization: `Bearer ${this.accessToken}` },
      auth: { token: this.accessToken },
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

    this.socket.on('connect_error', (e) =>
      log.warn('WS', 'connect_error ' + e.message),
    );

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
    });
    this.socket.emit('farm:snapshot:request');
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
