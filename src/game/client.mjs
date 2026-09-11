import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { requestBridge } from '../bridge/client.mjs';
import { TerrainMemory } from '../navigation/terrain.mjs';
import { SurfaceMemory } from '../navigation/surface.mjs';

// Game RPC only. Policies never construct lease owners, sequences or terrain cursors.
export class GameClient {
  map = new TerrainMemory();
  surface = new SurfaceMemory();
  constructor(send = requestBridge) { this.send = send; }
  io(request) {
    return Effect.tryPromise({
      try: async signal => {
        const result = await this.send(request, { signal });
        if (!result.ok) throw new Error(result.error ?? 'Game refused action');
        return result;
      },
      catch: error => error instanceof Error ? error : new Error(String(error)),
    });
  }
  // Both perception streams ride on one request: near-field geometry and
  // far-field surface, each under its own session/cursor.
  cursors() {
    return { session: this.map.session, after: this.map.cursor,
      surfaceSession: this.surface.session, surfaceAfter: this.surface.cursor };
  }
  remember(batch) { this.map.apply(batch.terrain); if (batch.surface) this.surface.apply(batch.surface); }
  sense() {
    return this.io({ action: 'sense', ...this.cursors() }).pipe(
      Effect.tap(batch => Effect.sync(() => this.remember(batch))),
    );
  }
  snapshot() {
    return Effect.gen(this, function* () {
      // 16,384 retained entries / 128 per page, plus headroom for live refreshes.
      for (let pages = 0; pages < 256; pages++) {
        const batch = yield* this.sense();
        if (!batch.terrain.more && !batch.surface?.more) return batch.state;
      }
      return yield* Effect.fail(new Error('Terrain snapshot did not catch up'));
    });
  }
  control(initial, onCleanupError, { allowStarvingRecovery = false } = {}) {
    return Effect.gen(this, function* () {
      const owner = randomUUID().replaceAll('-', '');
      let sequence = 0;
      // Install cleanup before begin: a lost begin acknowledgement may still acquire ownership.
      yield* Effect.acquireRelease(Effect.succeed(owner), () =>
        this.io({ action: 'control_end', owner }).pipe(Effect.catchAll(error => Effect.sync(() => onCleanupError?.(error)))),
      );
      yield* this.io({ action: 'control_begin', owner, session: initial.life.session, epoch: initial.control.epoch,
        allowStarvingRecovery });
      return {
        owner,
        frame: frame => this.io({ ...frame, action: 'control_frame', owner, sequence: ++sequence, durationMs: frame.durationMs ?? 500 }),
        step: frame => this.io({ ...frame, action: 'control_step', owner, sequence: ++sequence, durationMs: frame.durationMs ?? 500,
          ...this.cursors() }).pipe(
          Effect.tap(batch => Effect.sync(() => this.remember(batch))),
        ),
      };
    });
  }
}
