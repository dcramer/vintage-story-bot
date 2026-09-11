import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { blockTarget } from '../controller/schemas.mjs';
import { useOnBlock } from '../skills/use.mjs';
import { cleanName, runField } from '../skills/task.mjs';

export default defineGoal({
  name: 'use_on_block',
  schema: z.object({
    target: blockTarget,
    item: z.string().min(1).max(160).nullable().optional().describe('Item code to equip first; null = empty hand; omitted = current slot.'),
    sneak: z.boolean().default(false).describe('Shift modifier: ground storage, knapping/clay surface, firepit creation.'),
    holdMs: z.number().int().min(100).max(2000).default(600),
    expectAfter: z.string().min(1).max(64).optional().describe('Substring the target cell code must contain afterwards, e.g. farmland.'),
    consume: z.boolean().default(false).describe('Require the held item count to drop.'),
    timeoutMs: z.number().int().min(1000).max(60000).default(20000),
  }).strict(),
  destructive: true,
  description:
    'Aim at one observed block within reach and hold right-click with the held item, optionally sneaking. Verifies a target-cell ' +
    'code change or item consumption (till, plant, water, ignite, ground placement, kiln layers); no_observed_effect otherwise. ' +
    'No walking, GUI dialogs or retries. Returns START; poll goal_status for client-observed outcome.',
  announce: args => `Working on a block${args.item ? ` with ${cleanName(args.item)}` : ''}.`,
  run: (env, options) => runField(env, options, ['inventory', 'sneak'], (field, _, o) => useOnBlock(field, o)),
});
