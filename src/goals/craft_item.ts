import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { learn } from '../support/facts.ts';
import { itemCount, ownedSlots } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';

const gridSlots = inventory => inventory.inventories.find(i => i.name === 'craftinggrid')?.slots.filter(s => s.slot < 9) ?? [];
const emptyOwned = (inventory, exclude = new Set()) => ownedSlots(inventory).find(s => !s.bag && !s.code && !exclude.has(`${s.inventory}:${s.slot}`));

// Native bag slots accept wearable outputs even when the ordinary pack is full.
export function craftDestination(inventory, output, quantity, facts) {
  const slots = ownedSlots(inventory);
  return (
    slots.find(s => !s.bag && s.code === output && s.quantity + quantity <= (facts?.maxStackSize ?? 1)) ??
    emptyOwned(inventory) ??
    (facts?.bagSlots > 0 && quantity === 1 ? slots.find(s => s.bag && !s.code) : undefined)
  );
}

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
    const maximum = (await learn(field, slot.code))?.maxStackSize ?? 1;
    const destination =
      ownedSlots(inventory).find(s => !s.bag && s.code === slot.code && s.quantity + slot.quantity <= maximum) ?? emptyOwned(inventory);
    if (!destination) throw Error('Crafting grid holds items and no empty owned slot can receive them');
    await transfer(
      field,
      { inventory: 'craftinggrid', slot: slot.slot },
      { inventory: destination.inventory, slot: destination.slot },
      slot.quantity,
    );
    inventory = await field.send({ action: 'inventory' });
  }
  return inventory;
}

// Allocate owned stacks to recipe ingredients without double-spending a stack.
export function allocate(recipe, crafts = 1) {
  const remaining = new Map();
  const plan = [];
  for (const ingredient of recipe.ingredients ?? []) {
    if (!ingredient) continue;
    let needed = ingredient.quantity * (ingredient.consume === false ? 1 : crafts);
    const inPlace = match => match.inventory === 'craftinggrid' && match.slot === ingredient.slot;
    for (const match of [...(ingredient.matches ?? [])].sort((a, b) => Number(inPlace(b)) - Number(inPlace(a)))) {
      const id = `${match.inventory}:${match.slot}`;
      const available = remaining.get(id) ?? match.quantity;
      if (available <= 0 || needed <= 0) continue;
      const take = Math.min(available, needed);
      remaining.set(id, available - take);
      if (!inPlace(match))
        plan.push({
          from: { inventory: match.inventory, slot: match.slot },
          to: { inventory: 'craftinggrid', slot: ingredient.slot },
          quantity: take,
        });
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
  const outputFacts = await learn(field, output);
  const initial = itemCount(inventory, output);
  const gained = () => itemCount(inventory, output) - initial;
  let crafts = 0;
  try {
    while (gained() < count) {
      await field.observe();
      const recipes = await search();
      let recipe, plan;
      for (const candidate of recipes) {
        // Stage the requested batch together: consuming a whole ingredient
        // stack frees its slot even when the pack had no empty slot to start.
        for (let batch = Math.ceil((count - gained()) / candidate.output.quantity); batch >= 1; batch--) {
          plan = allocate(candidate, batch);
          if (plan) break;
        }
        if (plan) {
          recipe = candidate;
          break;
        }
      }
      if (!recipe)
        return {
          ok: false,
          reason: 'missing_ingredients',
          output,
          gained: gained(),
          crafts,
          recipes: recipes.map(r => ({ id: r.id, ingredients: r.ingredients?.filter(Boolean).map(i => ({ code: i.code, quantity: i.quantity })) })),
        };
      field.report('placing_ingredients', { output, recipe: recipe.id, gained: gained(), crafts });
      for (const step of plan) await transfer(field, step.from, step.to, step.quantity);
      inventory = await field.send({ action: 'inventory' });
      if (inventory.crafting?.recipeId == null) {
        await clearGrid(field);
        return { ok: false, reason: 'grid_not_matching', output, recipe: recipe.id, gained: gained(), crafts };
      }
      const destination = craftDestination(inventory, output, recipe.output.quantity, outputFacts);
      if (!destination) {
        await clearGrid(field);
        return { ok: false, reason: 'no_empty_slot_for_output', output, gained: gained(), crafts };
      }
      field.report('crafting', { output, recipe: recipe.id, gained: gained(), crafts });
      await field.send({
        action: 'craft',
        to: { inventory: destination.inventory, slot: destination.slot },
        expectedState: inventory.state,
        expectedOutput: output,
      });
      const crafted = await field.until((_, contents) => itemCount(contents, output) >= itemCount(inventory, output) + recipe.output.quantity, {
        timeoutMs: 2000,
        everyMs: 200,
        read: () => field.send({ action: 'inventory' }),
      });
      if (crafted.met) inventory = crafted.read;
      else {
        await clearGrid(field);
        return { ok: false, reason: 'craft_unverified', output, gained: gained(), crafts };
      }
      crafts++;
    }
    return { ok: true, goal: 'craft_item', output, count, gained: gained(), crafts, verification: 'inventory_delta' };
  } finally {
    await clearGrid(field).catch(() => {});
  }
}

export default defineGoal({
  name: 'craft_item',
  schema: z
    .object({
      output: z.string().min(1).max(160).describe('Exact output item/block code, e.g. game:packeddirt.'),
      count: z.number().int().min(1).max(64).default(1).describe('Output items wanted; crafts repeat until carried gain reaches it.'),
      timeoutMs: z.number().int().min(1000).max(600000).default(120000),
    })
    .strict(),
  destructive: true,
  description:
    'Craft from own inventory via the 3x3 grid: pick a known recipe whose ingredients are carried, transfer them, craft into an ' +
    'compatible owned slot with room for the full output, verify the inventory gain, repeat until count. Clears the grid first and afterwards. No knapping/clay/' +
    'container access, no gathering. missing_ingredients lists candidate recipes. Returns START; poll goal_status.',
  title: args => `Craft ${args.count} × ${cleanName(args.output)}`,
  announce: args => `Crafting ${cleanName(args.output)}.`,
  run: (env, options) => runField(env, options, ['inventory', 'grid_craft', 'craft_merge', 'item_info'], (field, _, o) => craftItem(field, o)),
});
