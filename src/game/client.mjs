import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { requestBridge } from '../bridge/client.mjs';
import { TerrainMemory } from '../navigation/terrain.mjs';

// Game RPC only. Policies never construct lease owners, sequences or terrain cursors.
export class GameClient {
  map = new TerrainMemory();
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
  sense() {
    return this.io({ action: 'sense', session: this.map.session, after: this.map.cursor }).pipe(
      Effect.tap(batch => Effect.sync(() => this.map.apply(batch.terrain))),
    );
  }
  snapshot() {
    return Effect.gen(this, function* () {
      for (let pages = 0; pages < 64; pages++) {
        const batch = yield* this.sense();
        if (!batch.terrain.more) return batch.state;
      }
      return yield* Effect.fail(new Error('Terrain snapshot did not catch up'));
    });
  }
  control(initial, onCleanupError) {
    return Effect.gen(this, function* () {
      const owner = randomUUID().replaceAll('-', '');
      let sequence = 0;
      // Install cleanup before begin: a lost begin acknowledgement may still acquire ownership.
      yield* Effect.acquireRelease(Effect.succeed(owner), () =>
        this.io({ action: 'control_end', owner }).pipe(Effect.catchAll(error => Effect.sync(() => onCleanupError?.(error)))),
      );
      yield* this.io({ action: 'control_begin', owner, session: initial.life.session, epoch: initial.control.epoch });
      return {
        owner,
        frame: frame => this.io({ ...frame, action: 'control_frame', owner, sequence: ++sequence, durationMs: 400 }),
      };
    });
  }
}
