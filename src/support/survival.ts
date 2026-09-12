import { collectItem } from '../goals/collect_item.ts';
import { horizontal } from '../runtime/navigation/terrain.ts';
import { aimAtObject, changeBlock } from './blocks.ts';
import { learnYields } from './facts.ts';
import {
  consume,
  emptyHand,
  foodCount,
  foodRecoverySatisfied,
  foodReserve,
  foodTolerance,
  foodYield,
  forageMatch,
  HUNGRY,
  hunger,
  shouldEat,
} from './food.ts';
import { ownedSlots } from './inventory.ts';
import { clearLeafPath } from './leaf-clearing.ts';
import { Search } from './search.ts';
import { nearestThreat } from './threats.ts';

// How far back a remembered bush or patch is worth walking to when nothing is in sight.
export const foodMemoryRange = 256;
const breaks = (object, tolerance = 0) => foodYield(object, undefined, tolerance)?.how === 'break';
// Worth walking to: yields food now and the server lets this player take it.
export const accessibleForage = object => {
  return breaks(object) ? object.access?.buildOrBreak !== false : object.access?.use !== false;
};
// Berries come off from anywhere in reach; a block that must be broken is dug
// from beside its cell, never from maximum reach or from on top of it, so the
// drop lands within pickup range.
export const harvestReady = (object, position, halfWidth = 0.3, tolerance = 0) =>
  object.withinPickingRange &&
  (!breaks(object, tolerance) ||
    (horizontal(position, object.point) <= 1.5 &&
      !(
        position.x + halfWidth > Math.floor(object.point.x) &&
        position.x - halfWidth < Math.floor(object.point.x) + 1 &&
        position.z + halfWidth > Math.floor(object.point.z) &&
        position.z - halfWidth < Math.floor(object.point.z) + 1
      )));
export const matchingFoodDrops = (objects, foodCode, point) =>
  objects
    .filter(object => object.kind === 'item' && object.code === foodCode && Number.isInteger(object.quantity) && object.quantity > 0)
    .sort((a, b) => horizontal(a.point, point) - horizontal(b.point, point));

// Take the food a seen block yields: a right-click harvest or a break and
// pickup, verified by more of that food carried. Returns whether any was
// gained; a block that could not be taken is set aside. Shared by the food
// search and by gleaning in passing.
export async function harvestFood(
  field,
  target,
  { tolerance = 0, onGain = null }: { tolerance?: number; onGain?: ((gain: number) => void) | null } = {},
) {
  await field.observe();
  const slot = await emptyHand(field);
  // Aimed by the block's own selection box from where the body stands now; the remembered angles are stale.
  await aimAtObject(field, target);
  const aimed = await field.observe();
  if (aimed.target?.key !== target.key) {
    field.skip(target, 5000);
    return false;
  }
  const detail = await field.send({ action: 'inspect_target' });
  await learnYields(field, [detail.code]);
  const yields = detail.key === target.key ? foodYield(detail, undefined, tolerance) : null;
  if (!yields) {
    field.skip(target);
    return false;
  }
  const { code: foodCode, how } = yields;
  const needsBreaking = how === 'break';
  if ((needsBreaking && detail.access?.buildOrBreak === false) || (!needsBreaking && detail.access?.use === false)) {
    field.skip(target, 300000);
    field.report('harvest_inaccessible', { target: target.key, food: foodCode });
    return false;
  }
  const inventory = await field.send({ action: 'inventory' });
  const count = contents =>
    ownedSlots(contents)
      .filter(s => s.code === foodCode)
      .reduce((n, s) => n + s.quantity, 0);
  const before = count(inventory);
  let reported = 0;
  const gained = async () => {
    const gain = count(await field.send({ action: 'inventory' })) - before;
    if (gain <= 0) return false;
    if (gain > reported) onGain?.(gain - reported);
    reported = Math.max(reported, gain);
    field.seen.delete(target.key);
    field.skip(target, 120000);
    return true;
  };
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
        return false;
      }
    } else {
      await field.send({
        action: 'interact',
        durationMs: 1200,
        expectedTarget: target.key,
        expectedState: inventory.state,
        expectedItem: { slot, code: null },
      });
      // The harvest is in the pack as soon as the count rises; no need to sit out the whole hold.
      await field.until(() => gained(), { timeoutMs: 1400, everyMs: 200 });
      await field.send({ action: 'stop' });
    }
    if ((await field.until(() => gained(), { timeoutMs: 2000, everyMs: 200 })).met) return true;
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
        if (await gained()) return true;
      }
    }
    // No blind mutation retry: skip the sighting, inspect other food sources.
    field.skip(target, 120000);
    field.report('harvest_unverified', { target: target.key });
    return false;
  } finally {
    await field.env.send({ action: 'stop' });
  }
}

// Food priority inside any goal. Below 20% the goal pauses and tend() takes
// over: eat what is carried, else search (support/search.ts) for what the
// handbook says yields food, harvest it, eat, and keep a reserve. A forced
// tend is the forage goal itself. Navigation checks pauseWhen every sensing
// tick; food work owns no parallel inputs.

export class Survival {
  field: any;
  tending = false;
  reserve = 0;
  eaten = 0;
  harvested = 0;
  initialFood = null;
  retained = 0;
  match = forageMatch;
  until = 0.8;
  keep = 320;
  search: Search | null = null;
  constructor(field) {
    this.field = field;
  }
  // How much a bite may hurt: nothing, unless starving.
  get tolerance() {
    return foodTolerance(hunger(this.field.latest));
  }
  forage = object => !!foodYield(object, undefined, this.tolerance) && accessibleForage(object);
  pauseWhen = state => (hunger(state) < HUNGRY ? 'food_needed' : null);
  // A walk during the food search stops when what is carried should be eaten.
  pauseFoodWalk = state => (shouldEat(hunger(state), this.reserve, this.until, this.keep) ? 'food_available' : null);
  // Read the pages of what came into view so its yield can be judged.
  learn = objects =>
    learnYields(
      this.field,
      objects.map(object => object.code),
    );
  async tend({
    force = false,
    toward,
    match,
    count,
    until,
    keep,
  }: {
    force?: boolean;
    toward?: any;
    match?: string[];
    count?: number;
    until?: number;
    keep?: number;
  } = {}) {
    if (until !== undefined) this.until = until;
    if (keep !== undefined) this.keep = keep;
    const field = this.field;
    this.match = match?.length ? match : forageMatch;
    await field.observe();
    if (!this.tending && !force && hunger(field.latest) >= HUNGRY) {
      field.recoveringFood = false;
      return;
    }
    this.tending = true;
    field.recoveringFood = true;
    const search = (this.search = new Search(field, {
      kind: 'food',
      match: this.match,
      wanted: this.forage,
      ready: (object, state) => harvestReady(object, state.position, state.body?.halfWidth, this.tolerance),
      take: object => this.harvest(object),
      approachExclude: target =>
        breaks(target, this.tolerance) ? q => Math.floor(q.x) === Math.floor(target.point.x) && Math.floor(q.z) === Math.floor(target.point.z) : null,
      learn: this.learn,
      habitats: ['edge', 'shore'],
      memoryRange: foodMemoryRange,
      pauseWhen: this.pauseFoodWalk,
    }));
    while (this.tending) {
      await field.observe(true);
      if (await field.evadeThreat(target => clearLeafPath(field, target))) {
        // Fled: leads the predator guards are set aside and the search goes on away from it.
        search.avoidThreat();
        continue;
      }
      const inventory = await field.send({ action: 'inventory' });
      const tolerance = this.tolerance;
      this.initialFood ??= foodCount(inventory, tolerance);
      this.retained = foodCount(inventory, tolerance) - this.initialFood;
      this.reserve = foodReserve(inventory, tolerance);
      const ratio = hunger(field.latest);
      field.report('food', {
        hunger: ratio,
        reserve: this.reserve,
        eaten: this.eaten,
        harvested: this.harvested,
        retained: this.retained,
        count,
      });
      if (count === undefined ? foodRecoverySatisfied(ratio, this.reserve, this.until, this.keep) : this.retained >= count) {
        this.tending = false;
        field.recoveringFood = false;
        await field.aim({ yawDegrees: field.heading, pitchDegrees: 15 });
        return;
      }
      if (shouldEat(ratio, this.reserve, this.until, this.keep)) {
        const result = await consume(field, { tolerance });
        this.eaten += result.consumed;
        continue;
      }
      // Nothing taken, seen or covered for a while: say so, rather than run to the deadline.
      if (search.exhausted()) {
        this.tending = false;
        field.recoveringFood = false;
        return { reason: 'none_found', unproductive: search.unproductive };
      }
      await search.step({ toward });
    }
  }
  async harvest(target) {
    const field = this.field;
    await field.observe();
    // A predator in the perimeter: the next loop turn flees first; the bush waits a moment.
    if (nearestThreat(field.latest)) {
      field.skip(target, 5000);
      return false;
    }
    return harvestFood(field, target, { tolerance: this.tolerance, onGain: gain => (this.harvested += gain) });
  }
}
