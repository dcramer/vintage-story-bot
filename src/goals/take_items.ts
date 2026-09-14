import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { cleanName, itemListName, runField } from '../support/task.ts';
import { exchange, wanted } from './store_items.ts';

export default defineGoal({
  name: 'take_items',
  schema: z
    .object({
      target: blockTarget.describe('Observed key of a chest, vessel or basket block.'),
      items: wanted,
      manageFood: z.boolean().default(false),
      sprint: z.boolean().default(false),
      avoidThreats: z
        .boolean()
        .default(true)
        .describe('Keep normal wildlife clearance; false is an explicit operator override for a known-risk retrieval.'),
      timeoutMs: z.number().int().min(5000).max(600000).default(180000),
    })
    .strict(),
  destructive: true,
  description:
    'Walk to an observed container block, open it by right-click, move matching items into own hotbar/bag ' +
    'slots (merging first, then empty slots) and close it. Each move is verified by counts on both sides; ' +
    'avoidThreats=false permits an explicit known-risk approach while retaining all terrain checks. ' +
    'stops at the first unverified or refused move (no_room, none_found). Returns START; poll goal_status.',
  title: args => `Take ${itemListName(args.items)} from storage`,
  announce: args => `Grabbing ${args.items.map(i => cleanName(i.item)).join(', ')} from storage.`,
  run: (env, options) =>
    runField(env, options, ['containers', 'inventory'], (field, survival, o) => exchange(field, survival, { ...o, direction: 'take' })),
});
