import { z } from 'zod';
import { defineAction } from '../action.mjs';

export default defineAction({
  name: 'collect_item',
  schema: z.object({
    target: z.string().max(64).regex(/^entity:\d+$/).describe('Specific dropped-item key from scan, not a loose-item block.'),
    expectedItem: z.string().min(1).max(160),
    radius: z.number().int().min(1).max(64).default(8),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(120000).default(60000),
  }).strict(),
  destructive: true,
  description:
    'Approach a currently visible dropped stack using safe navigation and native proximity pickup. ' +
    'Reacquires its identity between travel legs; no searching other targets, clicking, digging or ' +
    'swimming. Requires inventory gain covering its initially observed quantity; disappearance alone ' +
    'is not success. Delta does not prove entity causality. Partial pickup, lost targets and blocked ' +
    'routes report failure; damage/deadline/stop interrupt. Returns START; poll goal_status.',
});
