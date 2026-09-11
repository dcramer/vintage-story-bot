import { normalize } from '../navigation/terrain.mjs';
import { ownedSlots } from './inventory.mjs';

// Installed survival fruit assets; no inference that arbitrary nutritious items are safe raw.
export const berryTypes = new Set([
  'beautyberry', 'blueberry', 'cloudberry', 'cranberry', 'blackberry',
  'blackcurrant', 'raspberry', 'redcurrant', 'whitecurrant', 'strawberry',
]);
export const berryCode = code => typeof code === 'string' && code.startsWith('game:fruit-') && berryTypes.has(code.slice(11));
// Installed 1.22.7 assets with zero raw health penalty and no psychedelic effect.
export const mushroomTypes = new Set([
  'fieldmushroom', 'almondmushroom', 'blacktrumpet', 'chanterelle', 'commonmorel',
  'greencrackedrussula', 'indigomilkcap', 'kingbolete', 'lobster', 'orangeoakbolete',
  'paddystraw', 'puffball', 'redwinecap', 'saffronmilkcap', 'violetwebcap', 'witchhat',
  'honeymushroom',
]);
export const mushroomCode = code => typeof code === 'string' && /^game:mushroom-[a-z0-9]+-normal$/.test(code) &&
  mushroomTypes.has(code.slice(14, -7));
// Minimum installed crop stage that drops an edible raw item. Cassava,
// soybean, licorice and pineapple are deliberately absent.
export const cropFoods = new Map([
  ['amaranth', { stage: 8, code: 'game:grain-amaranth' }],
  ['cabbage', { stage: 11, code: 'game:vegetable-cabbage' }],
  ['carrot', { stage: 6, code: 'game:vegetable-carrot' }],
  ['fennel', { stage: 8, code: 'game:vegetable-fennel' }],
  ['flax', { stage: 9, code: 'game:grain-flax' }],
  ['onion', { stage: 6, code: 'game:vegetable-onion' }],
  ['parsnip', { stage: 7, code: 'game:vegetable-parsnip' }],
  ['peanut', { stage: 8, code: 'game:legume-peanut' }],
  ['rice', { stage: 10, code: 'game:grain-rice' }],
  ['rye', { stage: 9, code: 'game:grain-rye' }],
  ['spelt', { stage: 9, code: 'game:grain-spelt' }],
  ['sunflower', { stage: 12, code: 'game:grain-sunflower' }],
  ['turnip', { stage: 4, code: 'game:vegetable-turnip' }],
]);
const cropFoodCodes = new Set([...cropFoods.values()].map(food => food.code));
export const forageFoodCode = object => {
  if (object.forage?.kind !== 'crop') return object.forage?.foodCode;
  const food = cropFoods.get(object.forage.cropType);
  return food && object.forage.stage >= food.stage ? food.code : null;
};
export const ripeForage = object => object.kind === 'block' &&
  (object.forage?.ripe === true && (berryCode(object.forage.foodCode) || mushroomCode(object.forage.foodCode)) ||
    cropFoodCodes.has(forageFoodCode(object)));
export const safeFood = slot => (berryCode(slot.code) || mushroomCode(slot.code) || cropFoodCodes.has(slot.code)) && slot.quantity > 0 &&
  slot.nutrition?.saturation > 0 && slot.nutrition.health >= 0 && slot.freshness?.state === 'fresh';
export const foodReserve = inventory => ownedSlots(inventory).filter(safeFood)
  .reduce((sum, slot) => sum + slot.quantity * slot.nutrition.saturation, 0);
export function hunger(state) {
  const vital = state.vitals?.hunger;
  if (!Number.isFinite(vital?.current) || !Number.isFinite(vital?.max) || vital.max <= 0)
    throw Error('Hunger unavailable; cannot plan food safely');
  return vital.current / vital.max;
}

export async function emptyHand(field) {
  await field.observe();
  const inventory = await field.send({ action: 'inventory' });
  const slot = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && !s.code);
  if (!slot) throw Error('Harvest needs an empty hotbar slot; inventory management required');
  await field.send({ action: 'select', slot: slot.slot });
  return slot.slot;
}

export async function consume(field) {
  await field.observe();
  let inventory = await field.send({ action: 'inventory' });
  let food = ownedSlots(inventory).filter(safeFood)
    .sort((a, b) => a.freshness.freshHoursLeft - b.freshness.freshHoursLeft)[0];
  if (!food) throw Error('No verified fresh, safe forage in own inventory');
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
  const yaw = field.latest.orientation.yawDegrees;
  let before;
  for (const offset of [0, 90, -90, 180]) {
    await field.aim({ yawDegrees: normalize(yaw + offset), pitchDegrees: -15 });
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
    await field.send({ action: 'interact', durationMs: 1200, expectedTarget: null,
      expectedState: inventory.state, expectedItem: { slot: food.slot, code: food.code } });
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
