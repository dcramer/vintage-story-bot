import { randomUUID } from 'node:crypto';
import { requestBridge } from './bridge.ts';
import { SightingsMemory } from './navigation/sightings.ts';
import { SurfaceMemory } from './navigation/surface.ts';
import { TerrainMemory } from './navigation/terrain.ts';

// Blocks a player notices without looking for them; goals add to this, never replace it.
export const salient = ['ore', 'berry', 'stick', 'flint', 'loose', 'mushroom', 'cattail', 'chest', 'basket', 'vessel', 'fire', 'torch'];

// Game RPC only. Policies never construct control owners, sequences or terrain cursors.
// Perception memory lives here: the mod reports what the eye sees this instant,
// Node remembers.
export class GameClient {
  knowledge: any = null;
  send: (request: any, options?: any) => Promise<any>;
  map = new TerrainMemory();
  surface = new SurfaceMemory();
  sightings = new SightingsMemory();
  // Attention: block code substrings the eye is currently looking for.
  watch = [...salient];
  constructor(send = requestBridge) {
    this.send = async (request, options) => {
      const result: any = await send(request, options);
      // observe carries only this instant's entities; memory adds what left the view.
      if (request.action === 'observe' && result?.ok && Array.isArray(result.nearbyEntities)) {
        this.knowledge?.enter(result.world?.identifier);
        this.sightings.observeEntities(result.nearbyEntities);
        result.nearbyEntities = this.sightings.entities(result.position);
      }
      return result;
    };
  }
  attend(list = []) {
    this.watch = [...new Set([...salient, ...list])].slice(0, 16);
  }
  // A request whose refusal is an error; a cancelled signal rejects before it is sent.
  async io(request: object, signal?: AbortSignal): Promise<any> {
    const result = await this.send(request, { signal });
    if (!result.ok) throw new Error(result.error ?? 'Game refused action');
    return result;
  }
  // One request carries the surroundings geometry deltas plus snapshots of what
  // the eye sees right now (surface, sightings) and the current attention.
  cursors() {
    return { session: this.map.session, after: this.map.cursor, watch: this.watch };
  }
  remember(batch) {
    // Memory is per world: the save identifier selects which one is loaded.
    this.knowledge?.enter(batch.state?.world?.identifier);
    this.map.apply(batch.terrain);
    this.knowledge?.touch();
    if (batch.surface) this.surface.apply(batch.surface);
    if (batch.sightings) this.sightings.apply(batch.sightings);
    if (batch.sightings && batch.state) batch.state.nearbyEntities = this.sightings.entities(batch.state.position);
  }
  async sense(signal?: AbortSignal) {
    const batch = await this.io({ action: 'sense', ...this.cursors() }, signal);
    this.remember(batch);
    return batch;
  }
  async snapshot(signal?: AbortSignal) {
    // 16,384 retained entries / 128 per page, plus headroom for live refreshes.
    for (let pages = 0; pages < 256; pages++) {
      const batch = await this.sense(signal);
      if (!batch.terrain.more) return batch.state;
    }
    throw new Error('Terrain snapshot did not catch up');
  }
  // An exclusive hold on the inputs. release() always runs the game's own
  // control_end, even after a lost begin acknowledgement that may still have
  // acquired ownership, and never through a cancelled signal.
  async control(initial, onCleanupError, { allowStarvingRecovery = false } = {}, signal?: AbortSignal) {
    const owner = randomUUID().replaceAll('-', '');
    let sequence = 0,
      released = false;
    const release = async () => {
      if (released) return;
      released = true;
      try {
        await this.io({ action: 'control_end', owner });
      } catch (error) {
        onCleanupError?.(error);
      }
    };
    try {
      await this.io({ action: 'control_begin', owner, session: initial.life.session, epoch: initial.control.epoch, allowStarvingRecovery }, signal);
    } catch (error) {
      await release();
      throw error;
    }
    return {
      owner,
      release,
      frame: frame => this.io({ ...frame, action: 'control_frame', owner, sequence: ++sequence, durationMs: frame.durationMs ?? 500 }, signal),
      step: async frame => {
        const batch = await this.io(
          { ...frame, action: 'control_step', owner, sequence: ++sequence, durationMs: frame.durationMs ?? 500, ...this.cursors() },
          signal,
        );
        this.remember(batch);
        return batch;
      },
    };
  }
}
