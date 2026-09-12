import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { blockTarget } from '../controller/schemas.mjs';
import { exchange } from '../skills/containers.mjs';
import { cleanName, runField } from '../skills/task.mjs';

export const wanted = z.array(z.object({
  item: z.string().min(1).max(160).describe('Item code substring, e.g. cattailroot or game:flint.'),
  count: z.number().int().min(1).max(999).optional().describe('Omit to move every matching item.'),
}).strict()).min(1).max(16);

export default defineGoal({
  name: 'store',
  schema: z.object({
    target: blockTarget.describe('Observed key of a chest, vessel or basket block.'),
    items: wanted,
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(5000).max(600000).default(180000),
  }).strict(),
  destructive: true,
  description:
    'Walk to an observed container block, open it by right-click, move own items in (merging first, then ' +
    'empty slots) and close it. Each move is verified by counts on both sides; stops at the first unverified ' +
    'or refused move (no_room, transfer_unverified). Returns START; poll goal_status.',
  announce: args => `Putting ${args.items.map(i => cleanName(i.item)).join(', ')} away.`,
  run: (env, options) => runField(env, options, ['containers', 'inventory'],
    (field, survival, o) => exchange(field, survival, { ...o, direction: 'store' })),
});
