import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { parseBlockKey, selectCell } from '../support/blocks.ts';
import { cropRequirements, farmlandReadings, plantingProblem } from '../support/crops.ts';
import { itemCount, ownedSlots } from '../support/inventory.ts';
import { cleanName, runField } from '../support/task.ts';
import { useOnBlock } from './use_block.ts';

// One selected bed: till if needed, inspect its actual nutrients/moisture,
// plant one seed, and verify the crop and seed delta. The brain owns plots,
// fencing, irrigation, rotation, and choosing when to plant.
export async function plant(field, { target, item }) {
  const cell = parseBlockKey(target);
  const page = await field.send({ action: 'item_info', code: item });
  const crop = cropRequirements(page);
  const environment = await field.send({ action: 'environment' });
  const climateProblem = plantingProblem(crop, environment, null);
  if (climateProblem !== 'unknown_farmland') return { ok: false, goal: 'plant', reason: climateProblem, item };
  let selected = await selectCell(field, cell, { face: 'up' });
  if (selected?.key !== target) return { ok: false, goal: 'plant', reason: 'target_changed_or_obstructed', target };
  if (!selected.access?.use || !selected.access?.buildOrBreak) return { ok: false, goal: 'plant', reason: 'access_denied', target };
  const above = { x: cell.x, y: cell.y + 1, z: cell.z };
  const cover = field.env.map.get(above.x, above.y, above.z);
  if (!cover || cover.hazard || (cover.code && cover.code !== 'game:air') || cover.boxes.length)
    return { ok: false, goal: 'plant', reason: 'bed_not_clear', target };
  let inventory = await field.send({ action: 'inventory' });
  if (itemCount(inventory, item) < 1) return { ok: false, goal: 'plant', reason: 'missing_seed', item };
  if (selected.code.startsWith('game:soil-')) {
    if (!/^game:soil-(medium|high|compost)-/.test(selected.code)) return { ok: false, goal: 'plant', reason: 'low_fertility_soil', target };
    const hoe = ownedSlots(inventory).find(s => s.tool === 'Hoe' && s.durability > 0);
    if (!hoe) return { ok: false, goal: 'plant', reason: 'missing_hoe' };
    const tilled = await useOnBlock(field, { target, item: hoe.code, face: 'up', holdMs: 1200, expectAfter: 'game:farmland-' });
    if (!tilled.ok) return { ...tilled, goal: 'plant' };
    selected = await selectCell(field, cell, { face: 'up' });
  }
  if (!selected?.code?.startsWith('game:farmland-')) return { ok: false, goal: 'plant', reason: 'not_farmland', target };
  const soil = farmlandReadings(selected.info);
  const reason = plantingProblem(crop, await field.send({ action: 'environment' }), soil);
  if (reason) return { ok: false, goal: 'plant', reason, target: selected.key, soil, crop };
  inventory = await field.send({ action: 'inventory' });
  const before = itemCount(inventory, item);
  field.report('planting', { target: selected.key, item, nutrient: crop.nutrient });
  const result = await useOnBlock(field, { target: selected.key, item, face: 'up', holdMs: 300, consume: true });
  if (!result.ok) return { ...result, goal: 'plant' };
  const verified = await field.until(
    async () => {
      await field.observe();
      const planted = field.env.map.get(above.x, above.y, above.z);
      return planted?.code === crop.crop && itemCount(await field.send({ action: 'inventory' }), item) === before - 1;
    },
    { timeoutMs: 3000, everyMs: 200 },
  );
  return {
    ok: verified.met,
    goal: 'plant',
    ...(verified.met ? {} : { reason: 'plant_not_verified' }),
    cell: above,
    item,
    crop: crop.crop,
    nutrient: crop.nutrient,
    verification: 'crop_block,seed_delta',
  };
}

export default defineGoal({
  name: 'plant',
  schema: z
    .object({ target: blockTarget, item: z.string().regex(/^game:seeds-[a-z]+$/), timeoutMs: z.number().int().min(1000).max(60000).default(30000) })
    .strict(),
  destructive: true,
  description:
    'Till one observed medium-or-better soil block with a carried hoe, then plant one carried seed. Read handbook temperature and nutrient requirements, and native farmland moisture/nutrients before planting. Refuses cold, dry, depleted, occupied or unknown beds. No travel or irrigation; verifies crop block and seed consumption.',
  title: args => `Plant ${cleanName(args.item)}`,
  announce: args => `Planting ${cleanName(args.item)}.`,
  run: (env, options) =>
    runField(env, options, ['inventory', 'item_info', 'inspect_target', 'environment', 'block_facts'], field => plant(field, options)),
});
