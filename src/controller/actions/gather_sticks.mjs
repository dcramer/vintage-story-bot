import { z } from 'zod';
import { defineAction } from '../action.mjs';

export const schema = z.object({
  count: z.number().int().min(1).max(64).optional(),
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
}).strict();

export default defineAction({
  name: 'gather_sticks',
  schema,
  destructive: true,
  description:
    'Collect additional ground sticks only (default 10): scan, navigate, pick up and verify ' +
    'inventory gain. No leaf harvesting. Runs until count is reached or gameplay/cancellation ' +
    'interrupts; timeoutMs is optional, no default deadline. Failed routes trigger further ' +
    'search, not goal completion. Returns START and goal.id; poll observe.goal.progress/result. ' +
    'stop cancels globally.',
});
