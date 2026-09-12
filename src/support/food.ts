import { known } from './facts.ts';
import { ownedSlots } from './inventory.ts';

// Prior knowledge a player brings to a new world: what food tends to grow
// on, so a food search picks those out of what the eye has seen. Everything
// else is read from the game: the tooltip of what is held, the handbook page
// of what is seen. Nothing here gates what may be tried.
export const forageMatch = ['bush', 'mushroom', 'crop-', 'termitemound-', 'wildbeehive'];
// Below this the bot is hungry: it eats what it carries and, when starving,
// stomachs food that costs a little health rather than none at all.
export const HUNGRY = 0.2;
export const STARVING_TOLERANCE = 1;
export const foodTolerance = ratio => (ratio < HUNGRY ? STARVING_TOLERANCE : 0);
// Edible as the tooltip and handbook show it: feeds, hurts at most `tolerance`
// health (none by default), does not alter the mind.
export const edible = (nutrition, tolerance = 0) =>
  nutrition?.saturation > 0 && nutrition.health >= -tolerance && !(nutrition.psychedelic > 0) && !(nutrition.intoxication > 0);
export const safeFood = (slot, tolerance = 0) => slot.quantity > 0 && edible(slot.nutrition, tolerance) && slot.freshness?.state === 'fresh';
export const foodCount = (inventory, tolerance = 0) =>
  ownedSlots(inventory)
    .filter(slot => safeFood(slot, tolerance))
    .reduce((sum, slot) => sum + slot.quantity, 0);
export const foodReserve = (inventory, tolerance = 0) =>
  ownedSlots(inventory)
    .filter(slot => safeFood(slot, tolerance))
    .reduce((sum, slot) => sum + slot.quantity * slot.nutrition.saturation, 0);
// What a seen block yields as food, by the pages the bot has read: right-click
// harvest first (the block stays), then what breaking it drops. A harvest that
// needs a growth state waits until the block shows it. Unread pages yield nothing.
export const foodYield = (object, page = known(object.code), tolerance = 0) => {
  if (!page) return null;
  const harvest = page.harvest;
  if (harvest?.drops?.length && (!harvest.requiresGrowth || object.facts?.growth === harvest.requiresGrowth)) {
    const drop = harvest.drops.find(d => edible(known(d.code)?.nutrition, tolerance));
    if (drop) return { code: drop.code, how: 'use' };
  }
  const drop = (page.drops ?? []).find(d => edible(known(d.code)?.nutrition, tolerance));
  return drop ? { code: drop.code, how: 'break' } : null;
};
// Rationing: eat when hungry, or when the pack holds more than is being kept
// and the bar is below the target; otherwise walk on with the food carried.
export const shouldEat = (ratio, reserve, until, keep) => reserve > 0 && (ratio < HUNGRY || (ratio < until && reserve > keep));
// Done when fed to `until` with `keep` satiety worth of food in the pack.
export const foodRecoverySatisfied = (ratio, reserve, until = 0.8, keep = 320) => ratio >= until && reserve >= keep;
export function hunger(state) {
  const vital = state.vitals?.hunger;
  if (!Number.isFinite(vital?.current) || !Number.isFinite(vital?.max) || vital.max <= 0) throw Error('Hunger unavailable; cannot plan food safely');
  return vital.current / vital.max;
}

// A block a right-click does nothing to: plain earth or stone, never a container or anything worked.
export const inertTarget = target =>
  !!target?.traits && (target.traits.includes('diggable') || target.traits.includes('mineable')) && !target.traits.includes('container');
const eatingHeadings = [0, 45, 90, 135, 180, 225, 270, 315];
const eatingPitches = [-60, -30, 0, 30, 60];
export const eatingLooks = () => eatingPitches.flatMap(pitchDegrees => eatingHeadings.map(yawDegrees => ({ yawDegrees, pitchDegrees })));

export async function emptyHand(field) {
  await field.observe();
  const inventory = await field.send({ action: 'inventory' });
  const slot = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && !s.code);
  if (!slot) throw Error('Harvest needs an empty hotbar slot; inventory management required');
  await field.send({ action: 'select', slot: slot.slot });
  return slot.slot;
}

// Eat one item: the least harmful first, then the soonest to spoil.
export async function consume(field, { match, tolerance = 0 }: { match?: string; tolerance?: number } = {}) {
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  let food = ownedSlots(inventory)
    .filter(slot => safeFood(slot, tolerance))
    .filter(slot => !match || slot.code.toLowerCase().includes(match.toLowerCase()))
    .sort((a, b) => b.nutrition.health - a.nutrition.health || a.freshness.freshHoursLeft - b.freshness.freshHoursLeft)[0];
  if (!food) throw Error(match ? `No fresh edible food matching ${match} in own inventory` : 'No fresh edible food in own inventory');
  if (food.inventory !== 'hotbar') {
    const destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && !s.code);
    if (!destination) throw Error('Eating needs an empty hotbar slot');
    await field.send({
      action: 'inventory_move',
      from: { inventory: food.inventory, slot: food.slot },
      to: { inventory: 'hotbar', slot: destination.slot },
      quantity: 1,
      expectedState: inventory.state,
    });
    const slotFood = contents => ownedSlots(contents).find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
    const transfer = await field.until((_, contents) => safeFood(slotFood(contents) ?? {}, tolerance) && slotFood(contents).code === food.code, {
      timeoutMs: 1000,
      everyMs: 100,
      read: () => field.send({ action: 'inventory' }),
    });
    if (!transfer.met) throw Error('Food transfer unverified; inspect inventory');
    inventory = transfer.read;
    food = slotFood(inventory);
  }
  await field.send({ action: 'select', slot: food.slot });
  // Look for clear air without placing food or accidentally activating nearby
  // blocks. Sealed in a burrow there is none: a wall of earth or rock, which a
  // right-click does nothing to, will do.
  let before;
  let wall = null;
  for (const look of eatingLooks()) {
    await field.aim(look);
    before = await field.observe();
    if (!before.target) break;
    // Sealed in, the first wall of earth will do; forty more turns find no air.
    if (inertTarget(before.target)) {
      wall = look;
      break;
    }
  }
  if (before.target && wall) {
    await field.aim(wall);
    before = await field.observe();
  }
  if ((before.target && !inertTarget(before.target)) || before.activeSlot !== food.slot)
    throw Error('Eating needs clear air and the selected food slot');
  inventory = await field.send({ action: 'inventory' });
  const selected = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === food.slot);
  if (!safeFood(selected ?? {}, tolerance) || selected.code !== food.code) throw Error('Selected food changed');
  if (hunger(before) >= 0.98) throw Error('Already full; no food consumed');
  const quantity = ownedSlots(inventory)
    .filter(s => s.code === food.code)
    .reduce((n, s) => n + s.quantity, 0);
  field.report('eating', { food: food.code, hunger: hunger(before) });
  try {
    // The selected slot and exact food code are the mutation guard. A global
    // inventory-state token is too broad here: incidental nearby pickups can
    // change an unrelated slot between verification and the hold, even though
    // the intended food remains selected and safe.
    // Against a wall of earth the wall is the aimed target and must be named; in clear air there is none.
    await field.send({
      action: 'interact',
      durationMs: 1200,
      expectedTarget: before.target?.key ?? null,
      expectedItem: { slot: food.slot, code: food.code },
    });
    // Native consumption takes ~1s; poll life while the bounded hold runs.
    // The bite is in as soon as satiety rises; no need to sit out the whole hold.
    await field.until(state => hunger(state) > hunger(before) + 0.005, { timeoutMs: 1400, everyMs: 200 });
    await field.send({ action: 'stop' });
    const left = contents =>
      ownedSlots(contents)
        .filter(s => s.code === food.code)
        .reduce((n, s) => n + s.quantity, 0);
    const eaten = await field.until((after, contents) => left(contents) < quantity && after.vitals.hunger.current > before.vitals.hunger.current, {
      timeoutMs: 2000,
      everyMs: 200,
      read: () => field.send({ action: 'inventory' }),
    });
    if (!eaten.met) throw Error('Consumption unverified; inspect before another attempt');
    return {
      food: food.code,
      consumed: quantity - left(eaten.read),
      satietyGained: eaten.state.vitals.hunger.current - before.vitals.hunger.current,
    };
  } finally {
    await field.env.send({ action: 'stop' });
  }
}
