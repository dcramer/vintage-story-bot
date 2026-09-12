import { known } from './facts.ts';
import { ownedSlots } from './inventory.ts';

// Prior knowledge a player brings to a new world: where food tends to be
// found, so the eye watches for it. Everything else is read from the game:
// the tooltip of what is held, the handbook page of what is seen. Nothing
// here gates what may be tried.
export const forageWatch = ['bush', 'mushroom', 'crop-', 'termitemound-'];
// Edible as the tooltip and handbook show it: feeds, does not hurt, does not
// alter the mind.
export const edible = nutrition => nutrition?.saturation > 0 && nutrition.health >= 0 &&
  !(nutrition.psychedelic > 0) && !(nutrition.intoxication > 0);
export const safeFood = slot => slot.quantity > 0 && edible(slot.nutrition) && slot.freshness?.state === 'fresh';
export const foodCount = inventory => ownedSlots(inventory).filter(safeFood)
  .reduce((sum, slot) => sum + slot.quantity, 0);
export const foodReserve = inventory => ownedSlots(inventory).filter(safeFood)
  .reduce((sum, slot) => sum + slot.quantity * slot.nutrition.saturation, 0);
// What a seen block yields as food, by the pages the bot has read: right-click
// harvest first (the block stays), then what breaking it drops. A harvest that
// needs a growth state waits until the block shows it. Unread pages yield nothing.
export const foodYield = (object, page = known(object.code)) => {
  if (!page) return null;
  const harvest = page.harvest;
  if (harvest?.drops?.length && (!harvest.requiresGrowth || object.facts?.growth === harvest.requiresGrowth)) {
    const drop = harvest.drops.find(d => edible(known(d.code)?.nutrition));
    if (drop) return { code: drop.code, how: 'use' };
  }
  const drop = (page.drops ?? []).find(d => edible(known(d.code)?.nutrition));
  return drop ? { code: drop.code, how: 'break' } : null;
};
export function hunger(state) {
  const vital = state.vitals?.hunger;
  if (!Number.isFinite(vital?.current) || !Number.isFinite(vital?.max) || vital.max <= 0)
    throw Error('Hunger unavailable; cannot plan food safely');
  return vital.current / vital.max;
}

const eatingHeadings = [0, 45, 90, 135, 180, 225, 270, 315];
const eatingPitches = [-60, -30, 0, 30, 60];
export const eatingLooks = () => eatingPitches.flatMap(pitchDegrees =>
  eatingHeadings.map(yawDegrees => ({ yawDegrees, pitchDegrees })));

export async function emptyHand(field) {
  await field.observe();
  const inventory = await field.send({ action: 'inventory' });
  const slot = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && !s.code);
  if (!slot) throw Error('Harvest needs an empty hotbar slot; inventory management required');
  await field.send({ action: 'select', slot: slot.slot });
  return slot.slot;
}

export async function consume(field, { match }: { match?: string } = {}) {
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  let food = ownedSlots(inventory).filter(safeFood)
    .filter(slot => !match || slot.code.toLowerCase().includes(match.toLowerCase()))
    .sort((a, b) => a.freshness.freshHoursLeft - b.freshness.freshHoursLeft)[0];
  if (!food) throw Error(match ? `No fresh edible food matching ${match} in own inventory` : 'No fresh edible food in own inventory');
  if (food.inventory !== 'hotbar') {
    const destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && !s.code);
    if (!destination) throw Error('Eating needs an empty hotbar slot');
    await field.send({ action: 'inventory_move', from: { inventory: food.inventory, slot: food.slot },
      to: { inventory: 'hotbar', slot: destination.slot }, quantity: 1, expectedState: inventory.state });
    await field.wait(300);
    inventory = await field.send({ action: 'inventory' });
    const moved = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === destination.slot);
    if (!safeFood(moved ?? {}) || moved.code !== food.code) throw Error('Food transfer unverified; inspect inventory');
    food = moved;
  }
  await field.send({ action: 'select', slot: food.slot });
  // Look for clear air without placing food or accidentally activating nearby blocks.
  let before;
  for (const look of eatingLooks()) {
    await field.aim(look);
    before = await field.observe();
    if (!before.target) break;
  }
  if (before.target || before.activeSlot !== food.slot) throw Error('Eating needs clear air and the selected food slot');
  inventory = await field.send({ action: 'inventory' });
  const selected = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === food.slot);
  if (!safeFood(selected ?? {}) || selected.code !== food.code) throw Error('Selected food changed');
  if (hunger(before) >= .98) throw Error('Already full; no food consumed');
  const quantity = ownedSlots(inventory).filter(s => s.code === food.code).reduce((n, s) => n + s.quantity, 0);
  field.report('eating', { food: food.code, hunger: hunger(before) });
  try {
    // The selected slot and exact food code are the mutation guard. A global
    // inventory-state token is too broad here: incidental nearby pickups can
    // change an unrelated slot between verification and the hold, even though
    // the intended food remains selected and safe.
    await field.send({ action: 'interact', durationMs: 1200, expectedTarget: null,
      expectedItem: { slot: food.slot, code: food.code } });
    // Native consumption takes ~1s; poll life while the bounded hold runs.
    for (let i = 0; i < 7; i++) { await field.wait(200); await field.observe(); }
    await field.send({ action: 'stop' });
    for (let i = 0; i < 10; i++) {
      const after = await field.observe();
      const contents = await field.send({ action: 'inventory' });
      const remaining = ownedSlots(contents).filter(s => s.code === food.code).reduce((n, s) => n + s.quantity, 0);
      if (remaining < quantity && after.vitals.hunger.current > before.vitals.hunger.current)
        return { food: food.code, consumed: quantity - remaining,
          satietyGained: after.vitals.hunger.current - before.vitals.hunger.current };
      await field.wait(200);
    }
    throw Error('Consumption unverified; inspect before another attempt');
  } finally {
    await field.env.send({ action: 'stop' });
  }
}
