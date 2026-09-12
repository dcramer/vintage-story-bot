import { z } from 'zod';
import { defineGoal } from '../runtime/define.mjs';
import { itemCount, ownedSlots } from '../support/inventory.mjs';
import { cleanName, runField } from '../support/task.mjs';

const gridSlots = inventory => inventory.inventories.find(i => i.name === 'craftinggrid')?.slots.filter(s => s.slot < 9) ?? [];
const emptyOwned = (inventory, exclude = new Set()) => ownedSlots(inventory)
  .find(s => !s.code && !exclude.has(`${s.inventory}:${s.slot}`));

async function transfer(field, from, to, quantity) {
  await field.observe();
  const inventory = await field.send({ action: 'inventory' });
  const result = await field.send({ action: 'inventory_move', from, to, quantity, expectedState: inventory.state });
  if (result.moved !== quantity) throw Error(`Partial transfer ${result.moved}/${quantity}; inspect inventory`);
  await field.wait(150);
}

// Return every grid input to own inventory; never leave ingredients or tools stranded in the grid.
export async function clearGrid(field) {
  let inventory = await field.send({ action: 'inventory' });
  for (const slot of gridSlots(inventory).filter(s => s.code)) {
    const destination = emptyOwned(inventory);
    if (!destination) throw Error('Crafting grid holds items and no empty owned slot can receive them');
    await transfer(field, { inventory: 'craftinggrid', slot: slot.slot }, { inventory: destination.inventory, slot: destination.slot }, slot.quantity);
    inventory = await field.send({ action: 'inventory' });
  }
  return inventory;
}

// Allocate owned stacks to recipe ingredients without double-spending a stack.
export function allocate(recipe) {
  const remaining = new Map();
  const plan = [];
  for (const ingredient of recipe.ingredients ?? []) {
    if (!ingredient) continue;
    let needed = ingredient.quantity;
    for (const match of ingredient.matches ?? []) {
      const id = `${match.inventory}:${match.slot}`;
      const available = remaining.get(id) ?? match.quantity;
      if (available <= 0 || needed <= 0) continue;
      const take = Math.min(available, needed);
      remaining.set(id, available - take);
      plan.push({ from: { inventory: match.inventory, slot: match.slot }, to: { inventory: 'craftinggrid', slot: ingredient.slot }, quantity: take });
      needed -= take;
    }
    if (needed > 0) return null;
  }
  return plan;
}

export async function craftItem(field, { output, count = 1 }) {
  const match = output.split(':').pop().slice(0, 64);
  const search = async () => {
    const found = [];
    for (let offset = 0, more = true; more && offset < 40; offset += 8) {
      const page = await field.send({ action: 'recipes', match, offset, limit: 8 });
      found.push(...page.recipes.filter(r => r.output.code === output));
      more = page.more;
    }
    return found;
  };
  await field.observe();
  if (!(await search()).length) throw Error('No known 3x3 grid recipe with that exact output code');
  let inventory = await clearGrid(field);
  const initial = itemCount(inventory, output);
  const gained = () => itemCount(inventory, output) - initial;
  let crafts = 0;
  try {
    while (gained() < count) {
      await field.observe();
      const recipes = await search();
      let recipe, plan;
      for (const candidate of recipes) { plan = allocate(candidate); if (plan) { recipe = candidate; break; } }
      if (!recipe) return { ok: false, reason: 'missing_ingredients', output, gained: gained(), crafts,
        recipes: recipes.map(r => ({ id: r.id, ingredients: r.ingredients?.filter(Boolean).map(i => ({ code: i.code, quantity: i.quantity })) })) };
      field.report('placing_ingredients', { output, recipe: recipe.id, gained: gained(), crafts });
      for (const step of plan) await transfer(field, step.from, step.to, step.quantity);
      inventory = await field.send({ action: 'inventory' });
      if (inventory.crafting?.recipeId == null) {
        await clearGrid(field);
        return { ok: false, reason: 'grid_not_matching', output, recipe: recipe.id, gained: gained(), crafts };
      }
      const destination = emptyOwned(inventory);
      if (!destination) { await clearGrid(field); return { ok: false, reason: 'no_empty_slot_for_output', output, gained: gained(), crafts }; }
      field.report('crafting', { output, recipe: recipe.id, gained: gained(), crafts });
      await field.send({ action: 'craft', to: { inventory: destination.inventory, slot: destination.slot },
        expectedState: inventory.state, expectedOutput: output });
      let verified = false;
      for (let i = 0; i < 10; i++) {
        await field.wait(200);
        await field.observe();
        const contents = await field.send({ action: 'inventory' });
        if (itemCount(contents, output) >= itemCount(inventory, output) + recipe.output.quantity) { inventory = contents; verified = true; break; }
      }
      if (!verified) { await clearGrid(field); return { ok: false, reason: 'craft_unverified', output, gained: gained(), crafts }; }
      crafts++;
    }
    return { ok: true, goal: 'craft_item', output, count, gained: gained(), crafts, verification: 'inventory_delta' };
  } finally {
    await clearGrid(field).catch(() => {});
  }
}

export default defineGoal({
  name: 'craft_item',
  schema: z.object({
    output: z.string().min(1).max(160).describe('Exact output item/block code, e.g. game:packeddirt.'),
    count: z.number().int().min(1).max(64).default(1).describe('Output items wanted; crafts repeat until carried gain reaches it.'),
    timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  }).strict(),
  destructive: true,
  description:
    'Craft from own inventory via the 3x3 grid: pick a known recipe whose ingredients are carried, transfer them, craft into an ' +
    'empty owned slot, verify the inventory gain, repeat until count. Clears the grid first and afterwards. No knapping/clay/' +
    'container access, no gathering. missing_ingredients lists candidate recipes. Returns START; poll goal_status.',
  announce: args => `Crafting ${cleanName(args.output)}.`,
  run: (env, options) => runField(env, options, ['inventory', 'grid_craft'], (field, _, o) => craftItem(field, o)),
});
