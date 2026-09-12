import { horizontal } from '../runtime/navigation/terrain.ts';
import { aimAtObject } from './blocks.ts';
import { nearestThreat } from './threats.ts';
import { has } from './traits.ts';

// Picking up what the bot wants as it passes: loose sticks, stones and flints
// on the ground (a right-click), dropped items (walked over), and food where
// it grows (berries off a ripe bush, a mushroom broken off). Wants are code
// substrings the brain or an adapter sets; a walk pauses for one within a few
// blocks, the pickup happens, the walk goes on. Never a search of its own.
export const pickupBlock = object => object?.kind === 'block' && has(object, 'pickup');
export const handHarvest = object => object?.kind === 'block' && (has(object, 'pickup') || has(object, 'ready'));
// Food that comes off by hand: a right-click harvest that is ready, or a block that drops food when broken.
export const foodBlock = object => object?.kind === 'block' && has(object, 'food') && (!has(object, 'harvestable') || has(object, 'ready'));
export const gleanRadius = 6;
export const carried = state => [...(state.hotbar ?? []), ...(state.backpack ?? [])].reduce((n, s) => n + (s.quantity ?? 0), 0);

export class Gleaner {
  field: any;
  wants: any;
  pending = false;
  picked = 0;
  constructor(field, wants = []) {
    this.field = field;
    this.wants = wants;
  }
  wanted(object) {
    return (
      this.wants.some(w => object.code?.includes(w)) &&
      (object.kind === 'item' || handHarvest(object) || foodBlock(object)) &&
      !this.field.skipped.has(object.key)
    );
  }
  // What is wanted and close, nearest first.
  near(position) {
    const sightings = this.field.env.sightings;
    if (!sightings || !this.wants.length) return [];
    // Described sightings carry their traits, so wanted() does not derive them again on every frame.
    return sightings.view(position, { radius: gleanRadius, remembered: false }).filter(o => this.wanted(o));
  }
  // Nothing is worth stopping for with a hostile about: a flight is never paused for a stick.
  pauseWhen = state => (!this.pending && !nearestThreat(state) && this.near(state.position).length ? 'want_in_reach' : null);
  // Pick up what is near, a few things at most, then hand the walk back.
  async tend(limit = 3) {
    const field = this.field;
    this.pending = true;
    try {
      for (let n = 0; n < limit; n++) {
        await field.observe(true);
        const object = this.near(field.latest.position)[0];
        if (!object) return;
        field.report('gleaning', { target: object.key, code: object.code });
        let ok = false;
        try {
          // Loaded here: the collector and the food harvest compose fieldwork, which composes this.
          if (object.kind === 'item')
            ok = (
              await (
                await import('../goals/collect_item.ts')
              ).collectItem(field, { target: object.key, expectedItem: object.code, radius: gleanRadius })
            ).ok;
          else if (handHarvest(object) && !foodBlock(object)) ok = await this.pickup(object);
          else ok = await (await import('./survival.ts')).harvestFood(field, object);
        } catch (error) {
          if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
        }
        if (ok) this.picked++;
        else field.skip(object, 600000);
        field.env.sightings?.forget?.(object.key);
      }
    } finally {
      this.pending = false;
    }
  }
  // Walk within reach of a loose block, aim at it and right-click; verified by more items carried.
  async pickup(object) {
    const field = this.field;
    if (horizontal(field.latest.position, object.point) > field.latest.pickingRange - 0.5) {
      // A cell beside it when memory routes there, else anywhere within two blocks of it.
      const destination = field.approach(object) ?? { x: object.point.x, y: object.point.y, z: object.point.z, arrivalRadius: 2 };
      const walked = await field.leg(destination);
      if (!['arrived', 'paused'].includes(walked.state)) return false;
    }
    // Aimed by the block's own selection box from where the body stands now; remembered angles are stale after a walk.
    const selected = await aimAtObject(field, object);
    if (!selected || selected.key !== object.key) {
      field.report('pickup_missed', { target: object.key, selected: selected?.key ?? null });
      return false;
    }
    const before = carried(await field.observe());
    await field.send({ action: 'interact', expectedTarget: object.key, durationMs: 150 });
    await field.wait(500);
    const after = carried(await field.observe());
    await field.env.send({ action: 'stop' });
    return after > before;
  }
}
