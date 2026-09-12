import { horizontal, lookAt } from '../runtime/navigation/terrain.ts';
import { ownedSlots } from './inventory.ts';
import { nearestThreat } from './threats.ts';
import { has } from './traits.ts';

// Picking up what the bot wants as it passes: loose sticks, stones and flints
// on the ground (a right-click), and dropped items (walked over). Wants are
// code substrings the brain or an adapter sets; a walk pauses for one within
// a few blocks, the pickup happens, the walk goes on. Never a search of its own.
// Loose sticks, stones and flints: each is one right-click; so is a bush whose berries are on.
export const pickupBlock = object => object?.kind === 'block' && has(object, 'pickup');
export const handHarvest = object => object?.kind === 'block' && (has(object, 'pickup') || has(object, 'ready'));
export const gleanRadius = 6;
const carried = inventory => ownedSlots(inventory).reduce((n, s) => n + s.quantity, 0);

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
    return this.wants.some(w => object.code?.includes(w)) && (object.kind === 'item' || handHarvest(object)) && !this.field.skipped.has(object.key);
  }
  // What is wanted and close, nearest first.
  near(position) {
    const sightings = this.field.env.sightings;
    if (!sightings || !this.wants.length) return [];
    return sightings
      .visible(null)
      .filter(o => this.wanted(o) && horizontal(o.point, position) <= gleanRadius)
      .sort((a, b) => horizontal(a.point, position) - horizontal(b.point, position));
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
          // Loaded here: the collector composes fieldwork, which composes this.
          if (object.kind === 'item')
            ok = (
              await (
                await import('../goals/collect_item.ts')
              ).collectItem(field, { target: object.key, expectedItem: object.code, radius: gleanRadius })
            ).ok;
          else ok = await this.pickup(object);
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
    const eye = () => ({ ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight });
    if (horizontal(field.latest.position, object.point) > field.latest.pickingRange - 0.5) {
      const destination = field.approach(object);
      if (!destination) return false;
      const walked = await field.leg(destination);
      if (!['arrived', 'paused'].includes(walked.state)) return false;
    }
    await field.aim(object.look ?? lookAt(eye(), object.point));
    const aimed = await field.observe();
    if (aimed.target?.key !== object.key) return false;
    const before = carried(await field.send({ action: 'inventory' }));
    await field.send({ action: 'interact', expectedTarget: object.key, durationMs: 150 });
    await field.wait(500);
    await field.observe();
    await field.env.send({ action: 'stop' });
    return carried(await field.send({ action: 'inventory' })) > before;
  }
}
