import { config } from '../config.js';
import { actionId as mkActionId, moveId as mkMoveId, clientDebug } from '../util/ids.js';
import { tileToPixel, walkSteps } from '../util/tiles.js';
import { gaussianDelay, walkDurationMs, sleep } from '../safety/humanizer.js';

export class ActionRunner {
  constructor(socket, opts = {}) {
    this.s = socket;
    this.queue = Promise.resolve();
    this.minGap = opts.minGapMs ?? config.limits.minActionGapMs;
    this.maxGap = opts.maxGapMs ?? config.limits.maxActionGapMs;
    this.walk = opts.walk ?? true;
    this.backoff = opts.backoffMs ?? 1200;
    this.pos = { x: 784, y: 784 };
  }

  do(event, payload, meta) {
    const p = this.queue.then(() => this._run(event, payload, meta));
    this.queue = p.catch(() => {});
    return p;
  }

  async _walkTo(tileX, tileY) {
    if (!this.walk) return;
    const dest = tileToPixel(tileX, tileY);
    const steps = walkSteps(this.pos, dest);
    for (const st of steps) {
      this.s.emitAction('movementTargetUpdated', {
        roomId: config.roomId,
        target: dest,
        current: st,
        clientSentAt: Date.now(),
        moveId: mkMoveId(),
      });
      await sleep(Math.max(30, walkDurationMs(32) / steps.length));
    }
    this.s.emitAction('player:position', {
      roomId: config.roomId,
      target: dest,
      current: dest,
      clientSentAt: Date.now(),
    });
    this.pos = dest;
  }

  async _run(event, payload, meta, attempt = 0) {
    if (meta && payload.tileX != null) await this._walkTo(payload.tileX, payload.tileY);
    const id = mkActionId(meta?.action || 'act');
    const full = {
      roomId: config.roomId,
      ...payload,
      actionId: id,
      clientSentAt: Date.now(),
    };
    if (meta) {
      full.clientDebug = clientDebug({
        action: meta.action,
        tool: meta.tool,
        seedId: meta.seedId || 'none',
        tileX: payload.tileX,
        tileY: payload.tileY,
      });
      full.action = meta.action;
    }
    const result = await this._emitAndAwait(event, full, id);
    if (result === 'backpressure' && attempt < 4) {
      await sleep(this.backoff * (attempt + 1));
      return this._run(event, payload, meta, attempt + 1);
    }
    await sleep(gaussianDelay(this.minGap, this.maxGap));
    return result === true;
  }

  _emitAndAwait(event, full, id, timeoutMs = 8000) {
    return new Promise((resolve) => {
      const onEvent = (ev, data) => {
        if (!data || data.actionId !== id) return;
        if (ev === 'game:actionResult') { cleanup(); resolve(!!data.ok); }
        else if (ev === 'game:error' || ev === 'farm:error') {
          cleanup();
          resolve(data.code === 'ACTION_BACKPRESSURE' ? 'backpressure' : false);
        }
      };
      const to = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
      const cleanup = () => { clearTimeout(to); this.s.off('event', onEvent); };
      this.s.on('event', onEvent);
      this.s.emitAction(event, full);
    });
  }
}
