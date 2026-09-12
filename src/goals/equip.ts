import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { equip } from '../support/inventory.ts';
import { runField } from '../support/task.ts';

export default defineGoal({
  name: 'equip',
  schema: z
    .object({
      item: z.string().min(1).max(160).nullable().optional().describe('Exact item code; null selects an empty hand. Supply item OR tool.'),
      tool: z.string().min(1).max(64).optional().describe('Exact inventory.tool value, e.g. Shovel. Lowest adequate tier, then hotbar/durability.'),
      minTier: z.number().int().min(0).max(20).optional(),
      slot: z.number().int().min(0).max(9).optional().describe('Destination hotbar slot; must be empty unless already holding the selected item.'),
      timeoutMs: z.number().int().min(1000).max(15000).default(5000),
    })
    .strict()
    .refine(a => (a.item !== undefined) !== (a.tool !== undefined), 'Supply exactly one of item or tool')
    .refine(a => a.minTier === undefined || a.tool !== undefined, 'minTier requires tool'),
  destructive: true,
  description:
    'Equip an owned item/tool or empty hand. Selects a matching hotbar stack or transfers one item into an ' +
    'empty hotbar slot. No swaps, drops, armor/offhand or crafting. Verifies transfer and selection; ' +
    'never retries mutations. Returns START and goal.id; poll goal_status. Damage/session loss interrupt.',
  announce: () => 'Sorting out my gear.',
  run: (env, options) => runField(env, options, ['inventory'], (field, _, o) => equip(field, o)),
});
