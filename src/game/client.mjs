import { randomUUID } from 'node:crypto';
import { Effect } from 'effect';
import { requestBridge } from '../bridge/client.mjs';
import { TerrainMemory } from '../navigation/terrain.mjs';
import { SurfaceMemory } from '../navigation/surface.mjs';
import { SightingsMemory } from '../navigation/sightings.mjs';

// Blocks a player notices without looking for them; goals add to this, never replace it.
export const salient = ['ore', 'berry', 'stick', 'flint', 'loose', 'mushroom', 'cattail', 'chest', 'basket', 'vessel', 'fire', 'torch'];

// Game RPC only. Policies never construct lease owners, sequences or terrain cursors.
// Perception memory lives here: the mod reports what the eye sees this instant,
// Node remembers.
export class GameClient {
  map = new TerrainMemory();
  surface = new SurfaceMemory();
  sightings = new SightingsMemory();
  // Attention: block code substrings the eye is currently looking for.
  watch = [...salient];
  constructor(send = requestBridge) {
    this.send = async (request, options) => {
      const result = await send(request, options);
      // observe carries only this instant's entities; memory adds what left the view.
      if (request.action === 'observe' && result?.ok && Array.isArray(result.nearbyEntities)) {
        this.sightings.observeEntities(result.nearbyEntities);
        result.nearbyEntities = this.sightings.entities(result.position);
      }
      return result;
    };
  }
  attend(list = []) { this.watch = [...new Set([...salient, ...list])].slice(0, 16); }
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
  // One request carries the near-field geometry deltas plus snapshots of what
  // the eye sees right now (surface, sightings) and the current attention.
  cursors() { return { session: this.map.session, after: this.map.cursor, watch: this.watch }; }
  remember(batch) {
    this.map.apply(batch.terrain);
    if (batch.surface) this.surface.apply(batch.surface);
    if (batch.sightings) this.sightings.apply(batch.sightings);
    if (batch.sightings && batch.state) batch.state.nearbyEntities = this.sightings.entities(batch.state.position);
  }
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
        if (!batch.terrain.more) return batch.state;
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
