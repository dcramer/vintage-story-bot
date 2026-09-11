import { horizontal, normalize } from '../navigation/terrain.mjs';
import { sightRange } from './fieldwork.mjs';
import { changeBlock } from './blocks.mjs';
import { consume, emptyHand, foodReserve, hunger, mushroomCode, ripeForage } from './food.mjs';
import { ownedSlots } from './inventory.mjs';

const foodSightRange = Math.min(24, sightRange);
const foodSearchDistance = foodSightRange / 2;
const forageMatches = ['bush', 'mushroom'];

// Hysteresis: prepare food below 20%, eat to 80%, retain 320 satiety in safe fresh forage.
// Navigation checks yieldWhen every sensing tick; food work owns no parallel inputs.
export class Survival {
  tending = false;
  reserve = 0;
  eaten = 0;
  harvested = 0;
  surveyed = false;
  constructor(field) { this.field = field; }
  yieldWhen = state => hunger(state) < .2 ? 'food_needed' : null;
  eatWhen = state => this.reserve > 0 && hunger(state) < .8 ? 'food_available' : null;
  async tend({ force = false } = {}) {
    const field = this.field;
    await field.observe();
    if (!this.tending && !force && hunger(field.latest) >= .2) { field.recoveringFood = false; return; }
    this.tending = true;
    field.recoveringFood = true;
    while (this.tending) {
      await field.observe(true);
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
      const ready = near.find(o => ripeForage(o) && o.withinPickingRange && !field.rejected.has(o.key));
      if (ready) {
        await this.harvest(ready);
        continue;
      }
      // Shorter sweeps finish much sooner on low-tick-rate clients and let us
      // change viewpoints instead of starving during one enormous volume scan.
      await field.scan(foodSightRange, forageMatches, 'blocks');
      // One smooth initial look-around; don't walk away from food just behind the initial view.
      if (!this.surveyed && !field.targets(ripeForage).length) {
        this.surveyed = true;
        for (const offset of [120, 240]) {
          await field.aim({ yawDegrees: normalize(field.heading + offset), pitchDegrees: 15 });
          await field.scan(foodSightRange, forageMatches, 'blocks');
          if (field.targets(ripeForage).length) break;
        }
      }
      const target = field.targets(ripeForage)[0];
      if (target) {
        const destination = field.approach(target);
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
      await field.walk(field.explore(undefined, foodSearchDistance), this.eatWhen);
      // A changed viewpoint needs a fresh deterministic 360-degree sweep;
      // otherwise later searches only inspect the current forward cone.
      this.surveyed = false;
    }
  }
  async harvest(target) {
    const field = this.field;
    const slot = await emptyHand(field);
    await field.aim(target.look);
    const aimed = await field.observe();
    if (aimed.target?.key !== target.key) { field.reject(target, 5000); return; }
    const detail = await field.send({ action: 'inspect_target' });
    if (detail.key !== target.key || !ripeForage(detail)) { field.reject(target); return; }
    const inventory = await field.send({ action: 'inventory' });
    const count = contents => ownedSlots(contents).filter(s => s.code === detail.forage.foodCode)
      .reduce((n, s) => n + s.quantity, 0);
    const before = count(inventory);
    field.report('harvesting', { target: target.key, food: detail.forage.foodCode });
    try {
      if (mushroomCode(detail.forage.foodCode)) {
        const result = await changeBlock(field, 'dig', { target: target.key, point: detail.hit, slot, expectedItem: null });
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
