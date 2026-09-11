import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { harvest } from '../skills/harvest.mjs';
import { cleanName, runField } from '../skills/task.mjs';

export const schema = z.object({
  match: z.string().min(1).max(64).describe('Block code substring to dig, e.g. coopersreed, soil-, peat, tallgrass, mushroom.'),
  item: z.string().min(1).max(64).describe('Drop code substring counted as progress, e.g. cattailtops, game:soil-, drygrass.'),
  count: z.number().int().min(1).max(256).default(8),
  tool: z.string().min(1).max(64).optional().describe('Required tool class, e.g. Knife, Axe, Shovel; equips the lowest adequate tier.'),
  minTier: z.number().int().min(0).max(20).optional(),
  manageFood: z.boolean().default(true),
  sprint: z.boolean().default(false),
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
}).strict();

export default defineGoal({
  name: 'harvest',
  schema,
  destructive: true,
  description:
    'Dig visible blocks whose code contains match with the requested tool, walking between them, collecting matching drops and ' +
    'verifying carried gain until count. Transformed blocks (reeds → harvested) count when drops appear. Searches like gather_sticks; ' +
    'no default deadline. Food management yields to berries below 20%. Damage/death/control loss interrupt. Returns START; poll goal_status.',
  announce: args => `Off to gather ${cleanName(args.item ?? args.match)}.`,
  run: (env, options) => runField(env, { manageFood: true, ...options }, ['inventory', 'block_actions'], harvest),
});
