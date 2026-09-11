import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { runField } from '../skills/task.mjs';

export const schema = z.object({
  timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  sprint: z.boolean().optional(),
  match: z.array(z.string().min(1).max(32)).min(1).max(8).optional()
    .describe('Block code substrings the eye watches for; default bush, mushroom, crop-, termitemound-.'),
}).strict();

export default defineGoal({
  name: 'forage',
  schema,
  destructive: true,
  description:
    'Watch for the given block codes (default: bushes, mushrooms, crops, termite mounds), read the handbook ' +
    'page of what comes into view, and harvest what it says yields edible food right now (right-click harvest ' +
    'when a growth state allows it, else break); eat verified fresh food until at least 80% ' +
    'satiety with 320 satiety in reserve. No default deadline; unavailable food keeps exploration ' +
    'running. Damage/death/control loss cancels; never respawns or resumes automatically. ' +
    'Returns START and goal.id; poll goal_status. Needs an empty hotbar slot for harvesting. ' +
    'Optional sprint=true permits straight level sprinting only while food is at least 60%.',
  announce: () => 'Foraging for a bite to eat.',
  run: (env, options) => runField(env, { ...options, manageFood: true }, [], async (field, survival) => {
    await survival.tend({ force: true, watch: options.match });
    return { ok: true, goal: 'forage', eaten: survival.eaten, harvested: survival.harvested,
      reserve: survival.reserve, moved: +field.moved.toFixed(1), searched: field.searched };
  }),
});
