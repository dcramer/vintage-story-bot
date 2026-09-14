import { known } from './facts.ts';
import { equip, ownedSlots } from './inventory.ts';

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
// Expected satiety from the edible drop the handbook identifies, not a promised yield.
export function forageScore(object, position, tolerance = 0) {
  const yieldFood = foodYield(object, undefined, tolerance);
  if (!yieldFood) return Infinity;
  const page = known(object.code);
  const drops = yieldFood.how === 'use' ? page.harvest.drops : page.drops;
  const drop = drops.find(drop => drop.code === yieldFood.code);
  const nutrition = known(yieldFood.code)?.nutrition;
  const satiety = nutrition.saturation * (Number.isFinite(drop.quantity) ? Math.max(0, drop.quantity) : 1);
  if (satiety <= 0) return Infinity;
  const distance = Math.hypot(object.point.x - position.x, object.point.z - position.z);
  const climb = Math.abs(object.point.y - position.y) * 3;
  // Include taking/picking up, discount old leads, and strongly prefer harmless food.
  const effort = distance + climb + (yieldFood.how === 'use' ? 4 : 8);
  return (effort * 80) / Math.min(640, satiety) + Math.min(20, (object.ageMs ?? 0) / 60000) + Math.max(0, -nutrition.health) * 64;
}

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

// Make one ordinary hotbar slot available without discarding anything. This is
// only needed when the chosen food is in a worn bag; after the bite, that slot
// is empty again and any displaced tool or stack remains owned in the bag.
export function foodHotbarRoom(inventory) {
  const slots = ownedSlots(inventory);
  const to = slots.find(slot => slot.inventory === 'backpack' && !slot.bag && !slot.code);
  const from = slots
    .filter(slot => slot.inventory === 'hotbar' && slot.code && slot.quantity > 0)
    .sort((a, b) => Number(safeFood(a)) - Number(safeFood(b)) || Number(Boolean(a.tool)) - Number(Boolean(b.tool)) || a.slot - b.slot)[0];
  if (!from || !to) return null;
  return {
    action: 'inventory_move',
    from: { inventory: 'hotbar', slot: from.slot },
    to: { inventory: 'backpack', slot: to.slot },
    quantity: from.quantity,
    expectedState: inventory.state,
  };
}

export async function emptyHand(field) {
  // Harvesting food has the same native empty-hand requirement as loose
  // pickup. Reuse verified equipment management so a full hotbar can put one
  // ordinary stack into free worn-basket storage instead of abandoning food.
  return (await equip(field, { item: null })).slot;
}

// Eat one item: the least harmful first, then the soonest to spoil.
export async function consume(field, { match, tolerance = 0 }: { match?: string; tolerance?: number } = {}) {
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  const inventorySlot = (contents, address) => {
    const own = contents.inventories.find(i => i.name === address.inventory);
    return own?.slots.find(s => s.slot === address.slot);
  };
  let food = ownedSlots(inventory)
    .filter(slot => safeFood(slot, tolerance))
    .filter(slot => !match || slot.code.toLowerCase().includes(match.toLowerCase()))
    .sort((a, b) => b.nutrition.health - a.nutrition.health || a.freshness.freshHoursLeft - b.freshness.freshHoursLeft)[0];
  if (!food) throw Error(match ? `No fresh edible food matching ${match} in own inventory` : 'No fresh edible food in own inventory');
  if (food.inventory !== 'hotbar') {
    let rotated = false;
    let destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && !s.code);
    if (!destination) {
      const room = foodHotbarRoom(inventory);
      if (room) {
        const displaced = ownedSlots(inventory).find(s => s.inventory === room.from.inventory && s.slot === room.from.slot);
        await field.send(room);
        const cleared = await field.until(
          (_, contents) => {
            const slots = ownedSlots(contents);
            const source = slots.find(s => s.inventory === room.from.inventory && s.slot === room.from.slot);
            const stored = slots.find(s => s.inventory === room.to.inventory && s.slot === room.to.slot);
            return !source?.code && stored?.code === displaced?.code && stored?.quantity === displaced?.quantity;
          },
          { timeoutMs: 1000, everyMs: 100, read: () => field.send({ action: 'inventory' }) },
        );
        if (!cleared.met) throw Error('Hotbar transfer unverified; inspect inventory');
        inventory = cleared.read;
        destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === room.from.slot && !s.code);
      } else {
        // With every carried slot occupied, rotate through the native cursor:
        // hotbar stack -> mouse, whole food stack -> hotbar, mouse -> the food's
        // vacated pack slot. Nothing is dropped and every move is observed.
        const mouse = inventory.inventories.find(i => i.name === 'mouse')?.slots.find(s => !s.code);
        const displaced = ownedSlots(inventory)
          .filter(s => s.inventory === 'hotbar' && s.code && s.quantity > 0 && s.quantity <= 64 && s.slot !== field.latest.activeSlot)
          .sort((a, b) => Number(safeFood(a)) - Number(safeFood(b)) || Number(Boolean(a.tool)) - Number(Boolean(b.tool)) || a.slot - b.slot)[0];
        if (!mouse || !displaced || food.quantity > 64) throw Error('Eating needs an empty hotbar slot or reversible inventory rotation');
        const hotbar = { inventory: 'hotbar', slot: displaced.slot };
        const cursor = { inventory: 'mouse', slot: mouse.slot };
        const foodSlot = { inventory: food.inventory, slot: food.slot };
        await field.send({
          action: 'inventory_move',
          from: hotbar,
          to: cursor,
          quantity: displaced.quantity,
          expectedState: inventory.state,
        });
        const parked = await field.until(
          (_, contents) => !inventorySlot(contents, hotbar)?.code && inventorySlot(contents, cursor)?.code === displaced.code,
          { timeoutMs: 1000, everyMs: 100, read: () => field.send({ action: 'inventory' }) },
        );
        if (!parked.met) throw Error('Cursor parking unverified; inspect inventory');
        inventory = parked.read;
        await field.send({
          action: 'inventory_move',
          from: foodSlot,
          to: hotbar,
          quantity: food.quantity,
          expectedState: inventory.state,
        });
        const equipped = await field.until(
          (_, contents) =>
            inventorySlot(contents, hotbar)?.code === food.code &&
            inventorySlot(contents, hotbar)?.quantity === food.quantity &&
            !inventorySlot(contents, foodSlot)?.code,
          { timeoutMs: 1000, everyMs: 100, read: () => field.send({ action: 'inventory' }) },
        );
        if (!equipped.met) throw Error('Food rotation unverified; inspect inventory');
        inventory = equipped.read;
        await field.send({
          action: 'inventory_move',
          from: cursor,
          to: foodSlot,
          quantity: displaced.quantity,
          expectedState: inventory.state,
        });
        const restored = await field.until(
          (_, contents) =>
            !inventorySlot(contents, cursor)?.code &&
            inventorySlot(contents, foodSlot)?.code === displaced.code &&
            inventorySlot(contents, foodSlot)?.quantity === displaced.quantity,
          { timeoutMs: 1000, everyMs: 100, read: () => field.send({ action: 'inventory' }) },
        );
        if (!restored.met) throw Error('Cursor restoration unverified; inspect inventory');
        inventory = restored.read;
        destination = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === displaced.slot);
        food = destination;
        rotated = true;
      }
    }
    if (!destination) throw Error('Eating needs an empty hotbar slot');
    if (!rotated) {
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
