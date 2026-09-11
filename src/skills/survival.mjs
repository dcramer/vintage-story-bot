import { horizontal, normalize } from '../navigation/terrain.mjs';
import { sightRange, temporalStormUnsafe } from './fieldwork.mjs';
import { changeBlock } from './blocks.mjs';
import { consume, emptyHand, foodReserve, forageFoodCode, hunger, mushroomCode, ripeForage, termiteCode } from './food.mjs';
import { ownedSlots } from './inventory.mjs';

export const foodSightRange = Math.min(16, sightRange);
export const desperateFoodSightRange = Math.min(32, sightRange);
// Twelve-block steps overlap a 16-block sight cone while covering useful new
// ground before starvation. Navigation still validates every traversed cell.
export const foodSearchDistance = Math.min(12, foodSightRange * .75);
const forageMatches = ['bush', 'mushroom', 'crop-', 'termitemound-'];
const breaksForage = object => mushroomCode(forageFoodCode(object)) || termiteCode(forageFoodCode(object)) ||
  object.forage?.kind === 'crop';
export const accessibleForage = object => {
  return breaksForage(object) ? object.access?.buildOrBreak !== false : object.access?.use !== false;
};
export const harvestReady = (object, position, halfWidth = .3) => object.withinPickingRange && (!breaksForage(object) ||
  horizontal(position, object.point) <= 1.5 &&
  !(position.x + halfWidth > Math.floor(object.point.x) && position.x - halfWidth < Math.floor(object.point.x) + 1 &&
    position.z + halfWidth > Math.floor(object.point.z) && position.z - halfWidth < Math.floor(object.point.z) + 1));
export const foodViewChanged = (view, state) => !view || horizontal(view.position, state.position) > 2 ||
  Math.abs(normalize(state.orientation.yawDegrees - view.yawDegrees + 180) - 180) > 15;

// Hysteresis: prepare food below 20%, eat to 80%, retain 320 satiety in safe fresh forage.
// Navigation checks yieldWhen every sensing tick; food work owns no parallel inputs.
export class Survival {
  tending = false;
  reserve = 0;
  eaten = 0;
  harvested = 0;
  surveyed = false;
  desperateSurveyed = false;
  searchTarget = null;
  lastFarView = null;
  constructor(field) { this.field = field; }
  yieldWhen = state => temporalStormUnsafe(state) ? 'temporal_storm' : hunger(state) < .2 ? 'food_needed' : null;
  eatWhen = state => temporalStormUnsafe(state) ? 'temporal_storm' : this.reserve > 0 && hunger(state) < .8 ? 'food_available' : null;
  async tend({ force = false, toward } = {}) {
    const field = this.field;
    await field.observe();
    if (temporalStormUnsafe(field.latest)) throw Error('Temporal storm active or imminent; food work postponed.');
    if (!this.tending && !force && hunger(field.latest) >= .2) { field.recoveringFood = false; return; }
    this.tending = true;
    field.recoveringFood = true;
    while (this.tending) {
      await field.observe(true);
      if (temporalStormUnsafe(field.latest)) throw Error('Temporal storm active or imminent; food work postponed.');
      if (await field.evadeThreat()) {
        this.surveyed = false;
        this.searchTarget = null;
        continue;
      }
      const inventory = await field.send({ action: 'inventory' });
      this.reserve = foodReserve(inventory);
      field.report('food', { hunger: hunger(field.latest), reserve: this.reserve, eaten: this.eaten, harvested: this.harvested });
      if (hunger(field.latest) >= .8 && this.reserve >= 320) {
        this.tending = false;
        field.recoveringFood = false;
        await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
        return;
      }
      if (this.reserve > 0 && hunger(field.latest) < .8) {
        const result = await consume(field);
        this.eaten += result.consumed;
        continue;
      }
      // A single paged sweep finds both supported food families without enumerating unrelated blocks.
      const near = await field.scan(8, forageMatches, 'blocks');
      const ready = near.find(o => ripeForage(o) && accessibleForage(o) &&
        harvestReady(o, field.latest.position, field.latest.body.halfWidth) && !field.rejected.has(o.key));
      if (ready) {
        await this.harvest(ready);
        continue;
      }
      // Cache the distant cone until movement or a meaningful turn changes it.
      // Repeating the same paged volume scan cannot reveal new nearby food and
      // used to crowd out the short, known-terrain exploration step.
      if (foodViewChanged(this.lastFarView, field.latest)) {
        await field.scan(foodSightRange, forageMatches, 'blocks');
        this.lastFarView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
      }
      // One smooth initial look-around; don't walk away from food just behind the initial view.
      if (!this.surveyed && !field.targets(o => ripeForage(o) && accessibleForage(o)).length) {
        this.surveyed = true;
        for (const offset of [120, 240]) {
          await field.aim({ yawDegrees: normalize(field.heading + offset), pitchDegrees: 15 });
          await field.scan(foodSightRange, forageMatches, 'blocks');
          this.lastFarView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
          if (field.targets(o => ripeForage(o) && accessibleForage(o)).length) break;
        }
      }
      // Preserve the fast 16-block path normally. Below 10%, one structured
      // four-direction panorama is cheaper than exhausting the remaining
      // hunger window on short legs through a forage-poor pocket.
      if (!this.desperateSurveyed && hunger(field.latest) < .1 &&
          !field.targets(o => ripeForage(o) && accessibleForage(o)).length) {
        this.desperateSurveyed = true;
        for (const offset of [0, 90, 180, 270]) {
          await field.aim({ yawDegrees: normalize(field.heading + offset), pitchDegrees: 15 });
          await field.scan(desperateFoodSightRange, forageMatches, 'blocks');
          this.lastFarView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
          if (field.targets(o => ripeForage(o) && accessibleForage(o)).length) break;
        }
      }
      const target = field.targets(o => ripeForage(o) && accessibleForage(o))[0];
      if (target) {
        this.searchTarget = null;
        const destination = field.approach(target, breaksForage(target) ? q =>
          Math.floor(q.x) === Math.floor(target.point.x) && Math.floor(q.z) === Math.floor(target.point.z) : null);
        if (destination) {
          const result = await field.walk(destination, this.eatWhen);
          if (!['arrived', 'yielded'].includes(result.state)) field.reject(target, 15000);
          continue;
        }
        if (horizontal(field.latest.position, target.point) > 6) {
          const result = await field.walk(field.explore(target.point, foodSearchDistance), this.eatWhen);
          if (!['arrived', 'yielded'].includes(result.state)) field.reject(target, 15000);
          continue;
        }
        field.reject(target, 30000);
      }
      const before = { ...field.latest.position };
      const destination = this.searchTarget ?? field.explore(toward, foodSearchDistance);
      const result = await field.walk(destination, this.eatWhen);
      const progress = horizontal(before, field.latest.position);
      this.searchTarget = !['arrived', 'yielded'].includes(result.state) && progress > 2 ? destination : null;
      // A changed viewpoint needs a fresh deterministic 360-degree sweep;
      // otherwise later searches only inspect the current forward cone.
      if (progress > 2) {
        this.surveyed = false;
        this.desperateSurveyed = false;
      }
    }
  }
  async harvest(target) {
    const field = this.field;
    await field.observe();
    if (await field.evadeThreat()) return;
    const slot = await emptyHand(field);
    await field.aim(target.look);
    const aimed = await field.observe();
    if (aimed.target?.key !== target.key) { field.reject(target, 5000); return; }
    const detail = await field.send({ action: 'inspect_target' });
    if (detail.key !== target.key || !ripeForage(detail)) { field.reject(target); return; }
    await field.observe();
    if (await field.evadeThreat()) return;
    const foodCode = forageFoodCode(detail);
    const needsBreaking = breaksForage(detail);
    if (needsBreaking && detail.access?.buildOrBreak === false || !needsBreaking && detail.access?.use === false) {
      field.reject(target, 300000);
      field.report('harvest_inaccessible', { target: target.key, food: foodCode });
      return;
    }
    const inventory = await field.send({ action: 'inventory' });
    const count = contents => ownedSlots(contents).filter(s => s.code === foodCode)
      .reduce((n, s) => n + s.quantity, 0);
    const before = count(inventory);
    field.report('harvesting', { target: target.key, food: foodCode });
    try {
      if (needsBreaking) {
        const result = await changeBlock(field, 'dig', {
          target: target.key, point: detail.hit, slot, expectedItem: null,
          // Hand-harvestable forage should change quickly. Never spend the
          // remaining starvation window renewing one unreachable server target.
          timeoutMs: 12000,
        });
        if (!result.ok) { field.reject(target, 120000); return; }
      } else {
        await field.send({ action: 'interact', durationMs: 1200, expectedTarget: target.key,
          expectedState: inventory.state, expectedItem: { slot, code: null } });
        for (let i = 0; i < 7; i++) { await field.wait(200); await field.observe(); }
        await field.send({ action: 'stop' });
      }
      for (let i = 0; i < 10; i++) {
        await field.observe();
        const after = await field.send({ action: 'inventory' });
        const gain = count(after) - before;
        if (gain > 0) {
          this.harvested += gain;
          field.seen.delete(target.key);
          field.reject(target, 120000);
          return;
        }
        await field.wait(200);
      }
      // No blind mutation retry: quarantine the sighting, inspect other food sources.
      field.reject(target, 120000);
      field.report('harvest_unverified', { target: target.key });
    } finally {
      await field.env.send({ action: 'stop' });
    }
  }
}
