import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { cleanName, runField } from '../support/task.ts';
import { exchange, wanted } from './store.ts';

export default defineGoal({
  name: 'take',
  schema: z
    .object({
      target: blockTarget.describe('Observed key of a chest, vessel or basket block.'),
      items: wanted,
      manageFood: z.boolean().default(false),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(5000).max(600000).default(180000),
    })
    .strict(),
  destructive: true,
  description:
    'Walk to an observed container block, open it by right-click, move matching items into own hotbar/bag ' +
    'slots (merging first, then empty slots) and close it. Each move is verified by counts on both sides; ' +
    'stops at the first unverified or refused move (no_room, none_found). Returns START; poll goal_status.',
  announce: args => `Grabbing ${args.items.map(i => cleanName(i.item)).join(', ')} from storage.`,
  run: (env, options) =>
    runField(env, options, ['containers', 'inventory'], (field, survival, o) => exchange(field, survival, { ...o, direction: 'take' })),
});
