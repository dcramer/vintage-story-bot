import { z } from 'zod';
import { defineAction } from '../action.mjs';

export default defineAction({
  name: 'explore',
  schema: z.object({
    legs: z.number().int().min(1).max(16).default(4).describe('Exploration legs of up to 48 blocks, preferring unvisited regions.'),
    heading: z.number().min(0).max(360).optional().describe('Initial yaw in degrees; defaults to current facing.'),
    manageFood: z.boolean().default(true),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict(),
  destructive: true,
  description:
    'Walk exploration legs and scan after each; returns final position/heading and counts of sighted object codes ' +
    '(memory only, revalidate before acting). Food/interruption rules as gather_sticks. Returns START; poll goal_status.',
});
