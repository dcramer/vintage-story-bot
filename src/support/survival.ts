import { collectItem } from '../goals/collect_item.ts';
import { horizontal, normalize } from '../runtime/navigation/terrain.ts';
import { aimAtObject, changeBlock } from './blocks.ts';
import { learnYields } from './facts.ts';
import { sightRange } from './fieldwork.ts';
import { consume, emptyHand, foodCount, foodReserve, foodYield, forageWatch, hunger } from './food.ts';
import { ownedSlots } from './inventory.ts';
import { clearLeafPath } from './leaf-clearing.ts';
import { nearestThreat, threatClearDistance } from './threats.ts';

export const foodSightRange = Math.min(32, sightRange);
export const desperateFoodSightRange = Math.min(48, sightRange);
export const wideFoodSurveyNeeded = ratio => ratio < 0.2;
// Twelve-block steps overlap a 16-block sight cone while covering useful new
// ground before starvation. Navigation still validates every traversed cell.
export const foodSearchDistance = Math.min(24, foodSightRange * 0.75);
// How far back a remembered bush or patch is worth walking to when nothing is in sight.
export const foodMemoryRange = 128;
export const foodElevationDetourDistance = verticalRemaining =>
  verticalRemaining < 1.5 ? 0 : Math.min(foodSearchDistance, Math.max(6, verticalRemaining * 2));
// Done when fed to `until` with `keep` satiety in the pack, or once something was eaten and the bar is near `until`.
export const foodRecoverySatisfied = (ratio, reserve, eaten, until = 0.8, keep = 320) =>
  (ratio >= until && reserve >= keep) || (eaten > 0 && ratio + 0.2 >= until - 1e-9);
const breaks = object => foodYield(object)?.how === 'break';
// Worth walking to: yields food now and the server lets this player take it.
const forage = object => foodYield(object) && accessibleForage(object);
export const accessibleForage = object => {
  return breaks(object) ? object.access?.buildOrBreak !== false : object.access?.use !== false;
};
export const harvestReady = (object, position, halfWidth = 0.3) =>
  object.withinPickingRange &&
  (!breaks(object) ||
    (horizontal(position, object.point) <= 1.5 &&
      !(
        position.x + halfWidth > Math.floor(object.point.x) &&
        position.x - halfWidth < Math.floor(object.point.x) + 1 &&
        position.z + halfWidth > Math.floor(object.point.z) &&
        position.z - halfWidth < Math.floor(object.point.z) + 1
      )));
export const foodViewChanged = (view, state) =>
  !view || horizontal(view.position, state.position) > 2 || Math.abs(normalize(state.orientation.yawDegrees - view.yawDegrees + 180) - 180) > 15;
export const stuckFoodRoute = (result, before, after) => !['arrived', 'paused'].includes(result.state) && horizontal(before, after) <= 2;
export const unproductiveFoodApproach = (target, result, before, after) =>
  !['arrived', 'paused'].includes(result.state) && horizontal(after, target.point) + 2 >= horizontal(before, target.point);
const threatenedFoodApproach = result => result.state === 'paused' && result.reason === 'threat_near_food';
export const foodLeadGuarded = (target, threat) => !!threat && horizontal(target.point, threat.point) <= threatClearDistance(threat.code);
export const exhaustedFoodLead = (target, result, nearby = []) =>
  result.state === 'arrived' && target.visible === false && !nearby.some(object => object.key === target.key);
export const foodSearchBias = (stuckSearches, toward, habitat) => (stuckSearches >= 2 ? null : (toward ?? habitat));
// Nearby food several blocks above or below the body often needs a long,
// indirect climb. Prefer a slightly farther source at the current elevation
// instead of treating the overhead block as the nearest meal.
export const foodApproachScore = (position, target) => horizontal(position, target.point) + Math.abs((target.point.y ?? position.y) - position.y) * 3;
export const sameFoodPatch = (target, candidate) =>
  horizontal(target.point, candidate.point) <= 8 && Math.abs((target.point.y ?? 0) - (candidate.point.y ?? 0)) <= 3;
export const matchingFoodDrops = (objects, foodCode, point) =>
  objects
    .filter(object => object.kind === 'item' && object.code === foodCode && Number.isInteger(object.quantity) && object.quantity > 0)
    .sort((a, b) => horizontal(a.point, point) - horizontal(b.point, point));

// Hysteresis: prepare food below 20%. A successful recovery resumes travel at
// 60% instead of consuming that buffer while searching for a local stockpile;
// an already well-fed forced task may also finish with an ample reserve.
// Navigation checks pauseWhen every sensing tick; food work owns no parallel inputs.
export class Survival {
  field: any;
  tending = false;
  reserve = 0;
  eaten = 0;
  harvested = 0;
  initialFood = null;
  retained = 0;
  surveyed = false;
  desperateSurveyed = false;
  searchTarget = null;
  stuckSearches = 0;
  lastFarView = null;
  watch = forageWatch;
  constructor(field) {
    this.field = field;
  }
  // Look for food, then read the pages of what came into view so its yield can be judged.
  async study(radius) {
    const objects = await this.field.scan(radius, this.watch, 'blocks');
    await learnYields(
      this.field,
      objects.map(object => object.code),
    );
    return objects;
  }
  pauseWhen = state => (hunger(state) < 0.2 ? 'food_needed' : null);
  pauseFoodWalk = state => {
    if (this.reserve > 0 && hunger(state) < this.until) return 'food_available';
    // Give the forage loop control at the first predator sighting. Its next
    // iteration flees before doing anything else, while the interrupted food
    // lead is set aside below instead of pulling us back into the same danger.
    return nearestThreat(state) ? 'threat_near_food' : null;
  };
  avoidThreatenedFood(target) {
    const field = this.field;
    const threat = nearestThreat(field.latest);
    const guarded = threat ? field.targets(forage).filter(object => foodLeadGuarded(object, threat)) : [];
    if (foodLeadGuarded(target, threat) && !guarded.some(object => object.key === target.key)) guarded.push(target);
    for (const object of guarded) field.skip(object, 120000);
    field.report(guarded.length ? 'food_lead_threatened' : 'food_route_threatened', {
      target: target.key,
      threat: threat?.code,
      skipped: guarded.map(object => object.key),
    });
  }
  until = 0.8;
  keep = 320;
  async tend({
    force = false,
    toward,
    watch,
    count,
    until,
    keep,
  }: {
    force?: boolean;
    toward?: any;
    watch?: string[];
    count?: number;
    until?: number;
    keep?: number;
  } = {}) {
    if (until !== undefined) this.until = until;
    if (keep !== undefined) this.keep = keep;
    const field = this.field;
    this.watch = watch?.length ? watch : forageWatch;
    await field.observe();
    if (!this.tending && !force && hunger(field.latest) >= 0.2) {
      field.recoveringFood = false;
      return;
    }
    this.tending = true;
    field.recoveringFood = true;
    while (this.tending) {
      await field.observe(true);
      if (await field.evadeThreat(target => clearLeafPath(field, target))) {
        this.surveyed = false;
        this.searchTarget = null;
        continue;
      }
      const inventory = await field.send({ action: 'inventory' });
      this.initialFood ??= foodCount(inventory);
      this.retained = foodCount(inventory) - this.initialFood;
      this.reserve = foodReserve(inventory);
      field.report('food', {
        hunger: hunger(field.latest),
        reserve: this.reserve,
        eaten: this.eaten,
        harvested: this.harvested,
        retained: this.retained,
        count,
      });
      if (
        count === undefined ? foodRecoverySatisfied(hunger(field.latest), this.reserve, this.eaten, this.until, this.keep) : this.retained >= count
      ) {
        this.tending = false;
        field.recoveringFood = false;
        await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
        return;
      }
      if (this.reserve > 0 && hunger(field.latest) < this.until) {
        const result = await consume(field);
        this.eaten += result.consumed;
        continue;
      }
      // A single paged sweep finds both supported food families without enumerating unrelated blocks.
      const near = await this.study(8);
      const ready = near.find(o => forage(o) && harvestReady(o, field.latest.position, field.latest.body.halfWidth) && !field.skipped.has(o.key));
      if (ready) {
        await this.harvest(ready);
        continue;
      }
      // Cache the distant cone until movement or a meaningful turn changes it.
      // Repeating the same paged volume scan cannot reveal new nearby food and
      // used to crowd out the short, known-terrain exploration step.
      if (foodViewChanged(this.lastFarView, field.latest)) {
        await this.study(foodSightRange);
        this.lastFarView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
      }
      // One smooth initial look-around; don't walk away from food just behind the initial view.
      if (!this.surveyed && !field.targets(forage).length) {
        this.surveyed = true;
        for (const offset of [120, 240]) {
          await field.aim({ yawDegrees: normalize(field.heading + offset), pitchDegrees: 15 });
          await this.study(foodSightRange);
          this.lastFarView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
          if (field.targets(forage).length) break;
        }
      }
      // Once recovery starts below 20%, one structured four-direction sweep
      // is cheaper than spending half the remaining hunger window on short
      // legs through a forage-poor pocket. It still never activates food work
      // above the requested 20% threshold.
      if (!this.desperateSurveyed && wideFoodSurveyNeeded(hunger(field.latest)) && !field.targets(forage).length) {
        this.desperateSurveyed = true;
        for (const offset of [0, 90, 180, 270]) {
          await field.aim({ yawDegrees: normalize(field.heading + offset), pitchDegrees: 15 });
          await this.study(desperateFoodSightRange);
          this.lastFarView = { position: { ...field.latest.position }, yawDegrees: field.latest.orientation.yawDegrees };
          if (field.targets(forage).length) break;
        }
      }
      // Nothing in sight: what was seen before within walking distance is worth going back for.
      if (!field.targets(forage).length) {
        const remembered = field.recall(foodMemoryRange, this.watch, 'blocks');
        await learnYields(
          field,
          remembered.map(object => object.code),
        );
      }
      const target = field
        .targets(forage)
        .sort((a, b) => foodApproachScore(field.latest.position, a) - foodApproachScore(field.latest.position, b))[0];
      if (target) {
        this.searchTarget = null;
        const destination = field.approach(
          target,
          breaks(target) ? q => Math.floor(q.x) === Math.floor(target.point.x) && Math.floor(q.z) === Math.floor(target.point.z) : null,
        );
        if (destination) {
          const before = { ...field.latest.position };
          const result = await field.walk(destination, this.pauseFoodWalk);
          // The streamed eye is directional. After reaching an old lead, ask
          // the 360-degree nearby sensor before deciding the block is gone;
          // otherwise a mushroom just behind the camera is suppressed at the
          // exact moment it comes within reach.
          const nearby = result.state === 'arrived' && target.visible === false ? await this.study(8) : [];
          if (exhaustedFoodLead(target, result, nearby)) {
            // Reaching a remembered block's harvest position without seeing it
            // again is the successful-route version of a stale lead. Do not
            // orbit alternate approach cells around an occluded or gone block.
            field.skip(target, 120000);
            field.report('food_lead_unseen', { target: target.key });
          } else if (threatenedFoodApproach(result)) {
            this.avoidThreatenedFood(target);
          } else if (
            stuckFoodRoute(result, before, field.latest.position) ||
            unproductiveFoodApproach(target, result, before, field.latest.position)
          ) {
            const elevated = Math.abs((target.point.y ?? before.y) - before.y) > 2;
            for (const object of elevated ? field.targets(forage).filter(candidate => sameFoodPatch(target, candidate)) : [target])
              field.skip(object, 120000);
            await clearLeafPath(field, target.point);
          }
          continue;
        }
        const elevationDetour = foodElevationDetourDistance(Math.abs(field.latest.position.y - target.point.y));
        if (horizontal(field.latest.position, target.point) > 6 || elevationDetour) {
          const before = { ...field.latest.position };
          const result = await field.walk(field.explore(target.point, foodSearchDistance, elevationDetour), this.pauseFoodWalk);
          if (threatenedFoodApproach(result)) {
            this.avoidThreatenedFood(target);
          } else if (stuckFoodRoute(result, before, field.latest.position)) {
            const elevated = Math.abs((target.point.y ?? before.y) - before.y) > 2;
            for (const object of elevated ? field.targets(forage).filter(candidate => sameFoodPatch(target, candidate)) : [target])
              field.skip(object, 120000);
            await clearLeafPath(field, target.point);
          }
          continue;
        }
        field.skip(target, 30000);
      }
      const before = { ...field.latest.position };
      // With no food in sight, head for where it grows: forest edges, then the water's edge.
      // If that bias produced two stationary legs, rotate through reachable
      // local directions instead of selecting more points on the same cliff.
      const bias = foodSearchBias(this.stuckSearches, toward, field.habitat(['edge', 'shore']));
      const destination = this.searchTarget ?? field.explore(bias, foodSearchDistance);
      const result = await field.walk(destination, this.pauseFoodWalk);
      const progress = horizontal(before, field.latest.position);
      this.searchTarget = !['arrived', 'paused'].includes(result.state) && progress > 2 ? destination : null;
      if (stuckFoodRoute(result, before, field.latest.position)) {
        this.stuckSearches++;
        const cleared = await clearLeafPath(field, destination);
        if (cleared) {
          this.stuckSearches = 0;
          this.surveyed = false;
          this.desperateSurveyed = false;
          this.lastFarView = null;
        }
      } else this.stuckSearches = 0;
      // The initial panorama is retained for this recovery episode. Each moved
      // viewpoint already refreshes its 32-block forward cone above; repeating
      // a full panorama every short leg burns the starvation window on RPC.
    }
  }
  async harvest(target) {
    const field = this.field;
    await field.observe();
    if (await field.evadeThreat(target => clearLeafPath(field, target))) return;
    const slot = await emptyHand(field);
    // Aimed by the block's own selection box from where the body stands now; the remembered angles are stale.
    await aimAtObject(field, target);
    const aimed = await field.observe();
    if (aimed.target?.key !== target.key) {
      field.skip(target, 5000);
      return;
    }
    const detail = await field.send({ action: 'inspect_target' });
    await learnYields(field, [detail.code]);
    if (detail.key !== target.key || !foodYield(detail)) {
      field.skip(target);
      return;
    }
    await field.observe();
    if (await field.evadeThreat(target => clearLeafPath(field, target))) return;
    const { code: foodCode, how } = foodYield(detail);
    const needsBreaking = how === 'break';
    if ((needsBreaking && detail.access?.buildOrBreak === false) || (!needsBreaking && detail.access?.use === false)) {
      field.skip(target, 300000);
      field.report('harvest_inaccessible', { target: target.key, food: foodCode });
      return;
    }
    const inventory = await field.send({ action: 'inventory' });
    const count = contents =>
      ownedSlots(contents)
        .filter(s => s.code === foodCode)
        .reduce((n, s) => n + s.quantity, 0);
    const before = count(inventory);
    field.report('harvesting', { target: target.key, food: foodCode });
    try {
      if (needsBreaking) {
        const result = await changeBlock(field, 'dig', {
          target: target.key,
          point: detail.hit,
          slot,
          expectedItem: null,
          // Hand-harvestable forage should change quickly. Never spend the
          // remaining starvation window renewing one unreachable server target.
          timeoutMs: 12000,
        });
        if (!result.ok) {
          field.skip(target, 120000);
          return;
        }
      } else {
        await field.send({
          action: 'interact',
          durationMs: 1200,
          expectedTarget: target.key,
          expectedState: inventory.state,
          expectedItem: { slot, code: null },
        });
        for (let i = 0; i < 7; i++) {
          await field.wait(200);
          await field.observe();
        }
        await field.send({ action: 'stop' });
      }
      for (let i = 0; i < 10; i++) {
        await field.observe();
        const after = await field.send({ action: 'inventory' });
        const gain = count(after) - before;
        if (gain > 0) {
          this.harvested += gain;
          field.seen.delete(target.key);
          field.skip(target, 120000);
          return;
        }
        await field.wait(200);
      }
      if (needsBreaking) {
        // Broken forage can become a loose stack just outside native pickup
        // range. Reacquire only the exact expected food drop before giving
        // up on a block that the server already verified as changed.
        const drops = matchingFoodDrops(await field.scan(8, foodCode.slice(0, 64), 'items'), foodCode, detail.point);
        for (const drop of drops) {
          try {
            await collectItem(field, { target: drop.key, expectedItem: foodCode, radius: 8 });
          } catch (error) {
            if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
          }
          const after = await field.send({ action: 'inventory' });
          const gain = count(after) - before;
          if (gain > 0) {
            this.harvested += gain;
            field.seen.delete(target.key);
            field.skip(target, 120000);
            return;
          }
        }
      }
      // No blind mutation retry: skip the sighting, inspect other food sources.
      field.skip(target, 120000);
      field.report('harvest_unverified', { target: target.key });
    } finally {
      await field.env.send({ action: 'stop' });
    }
  }
}
