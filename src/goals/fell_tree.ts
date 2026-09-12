import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { runField } from '../support/task.ts';
import { harvest } from './harvest.ts';

export default defineGoal({
  name: 'fell_tree',
  schema: z
    .object({
      count: z.number().int().min(1).max(64).default(8).describe('Log items wanted.'),
      manageFood: z.boolean().default(false),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Chop grown logs with an owned axe, lowest reachable log first so whole trees fall, then collect dropped logs until count. ' +
    'Same search/food/interruption rules as harvest. No leaf stripping. Returns START; poll goal_status.',
  announce: () => 'Chopping down a tree for logs.',
  run: (env, { count = 8, ...options }) =>
    runField(env, { manageFood: false, ...options }, ['inventory', 'block_actions'], (field, survival, o) =>
      harvest(field, survival, { ...o, match: 'log-grown', item: 'game:log-', tool: 'Axe', count, lowest: true }).then(result => ({
        ...result,
        goal: 'fell_tree',
      })),
    ),
});
