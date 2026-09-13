import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { selectCell } from '../support/blocks.ts';
import { itemCount } from '../support/inventory.ts';
import { supportedFloor } from '../support/sites.ts';
import { runField } from '../support/task.ts';
import { useOnBlock } from './use_block.ts';

// Native construction is one grass placement followed by four firewood additions.
// Read the actual stage before each input so an interrupted goal can resume.
export async function makeFirepit(field, cell) {
  const failure = reason => ({ ok: false, goal: 'firepit', reason, cell });
  await field.observe();
  const block = field.env.map.get(cell.x, cell.y, cell.z);
  const code = block?.code ?? '';
  const stage = /^game:firepit-construct([1-4])$/.exec(code);
  const complete = /^game:firepit-(cold|extinct|lit)$/;
  if (complete.test(code)) {
    const selected = await selectCell(field, cell);
    if (!selected?.key.endsWith(`:${code}`)) return failure('firepit_not_observed');
    return { ok: true, goal: 'firepit', cell, code, verification: 'client_observed' };
  }
  if (!stage && (!block || block.hazard || (code && code !== 'game:air'))) return failure('site_not_empty');
  const floor = { ...cell, y: cell.y - 1 };
  if (!supportedFloor(field.env.map.get(floor.x, floor.y, floor.z), cell.y)) return failure('unsupported_site');
  const inventory = await field.send({ action: 'inventory' });
  const needed = stage ? 5 - Number(stage[1]) : 4;
  if (itemCount(inventory, 'game:firewood') < needed || (!stage && itemCount(inventory, 'game:drygrass') < 1)) return failure('not_enough_material');
  if (!stage) {
    const ground = await selectCell(field, floor, { face: 'up' });
    if (!ground) return failure('support_not_selectable');
    const placed = await useOnBlock(field, {
      target: ground.key,
      face: 'up',
      item: 'game:drygrass',
      sneak: true,
      consume: true,
      holdMs: 200,
    });
    if (!placed.ok) return { ...placed, goal: 'firepit', cell };
  }
  for (let expected = stage ? Number(stage[1]) : 1; expected <= 4; expected++) {
    const selected = await selectCell(field, cell);
    if (selected?.key !== `block:${field.latest.position.dimension}:${cell.x}:${cell.y}:${cell.z}:game:firepit-construct${expected}`)
      return failure('construction_stage_not_observed');
    const added = await useOnBlock(field, {
      target: selected.key,
      item: 'game:firewood',
      consume: true,
      holdMs: 200,
      expectAfter: expected === 4 ? 'game:firepit-cold' : `game:firepit-construct${expected + 1}`,
    });
    if (!added.ok) return { ...added, goal: 'firepit', cell };
  }
  const finished = await selectCell(field, cell);
  if (!finished?.key.endsWith(':game:firepit-cold')) return failure('firepit_not_observed');
  return { ok: true, goal: 'firepit', cell, code: 'game:firepit-cold', verification: 'client_observed' };
}

export default defineGoal({
  name: 'firepit',
  schema: z
    .object({
      x: z.number().int(),
      y: z.number().int(),
      z: z.number().int(),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    })
    .strict(),
  destructive: true,
  description:
    'Construct a firepit at an observed empty supported cell within picking range using one dry grass and four firewood. ' +
    'Resumes an owned unfinished firepit at the specified cell. Verifies every native construction stage; does not light it. Returns START; poll goal_status.',
  title: () => 'Build a firepit',
  announce: () => 'Building a firepit.',
  run: (env, { x, y, z, ...options }) => runField(env, options, ['inventory', 'sneak'], field => makeFirepit(field, { x, y, z })),
});
