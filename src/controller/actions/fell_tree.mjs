import { z } from 'zod';
import { defineAction } from '../action.mjs';

export default defineAction({
  name: 'fell_tree',
  schema: z.object({
    count: z.number().int().min(1).max(64).default(8).describe('Log items wanted.'),
    manageFood: z.boolean().default(true),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict(),
  destructive: true,
  description:
    'Chop grown logs with an owned axe, lowest reachable log first so whole trees fall, then collect dropped logs until count. ' +
    'Same search/food/interruption rules as harvest. No leaf stripping. Returns START; poll goal_status.',
});
