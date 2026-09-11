import { z } from 'zod';
import { defineAction } from '../action.mjs';

export const schema = z.object({
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  sprint: z.boolean().optional(),
}).strict();

export default defineAction({
  name: 'forage',
  schema,
  destructive: true,
  description:
    'Find visible ripe berry bushes, harvest and eat verified fresh berries until at least 80% ' +
    'satiety with 320 satiety in reserve. No default deadline; unavailable food keeps exploration ' +
    'running. Damage/death/control loss cancels; never respawns or resumes automatically. ' +
    'Returns START and goal.id; poll goal_status. Needs an empty hotbar slot for harvesting. ' +
    'Optional sprint=true permits straight level sprinting only while food is at least 60%.',
});
