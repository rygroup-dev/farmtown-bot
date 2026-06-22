// A tiny FIFO concurrency limiter (semaphore). Bounds how many async tasks run
// at once; extra tasks queue and start as slots free. Used to cap the number of
// simultaneous in-flight REST requests across the WHOLE fleet (all 49 farm
// engines share one Node process / one undici dispatcher) so a burst — e.g. every
// account re-binding its wallet at once on the slow /api/auth/wallet/verify — can't
// overwhelm the server and make every request time out together.
export class Limiter {
  constructor(max = 8) { this.max = Math.max(1, max); this.active = 0; this.queue = []; }

  run(fn) {
    return new Promise((resolve, reject) => {
      const start = () => {
        this.active++;
        Promise.resolve()
          .then(fn)
          .then(resolve, reject)
          .finally(() => { this.active--; this._next(); });
      };
      if (this.active < this.max) start();
      else this.queue.push(start);
    });
  }

  _next() {
    if (this.active < this.max && this.queue.length) this.queue.shift()();
  }
}
