import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { runField } from '../support/task.ts';

export const schema = z
  .object({
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    sprint: z.boolean().optional(),
    count: z
      .number()
      .int()
      .min(1)
      .max(256)
      .optional()
      .describe('Additional fresh food items to retain after anything eaten during the goal; omitted uses normal recovery targets.'),
    until: z.number().min(0.2).max(1).default(0.8).describe('Satiety fraction to eat up to; getting-started says half.'),
    keep: z.number().int().min(0).max(2000).default(320).describe('Satiety worth of fresh food to keep in the pack afterwards.'),
    match: z
      .array(z.string().min(1).max(32))
      .min(1)
      .max(8)
      .optional()
      .describe('Block code substrings the eye watches for; default bush, mushroom, crop-, termitemound-.'),
  })
  .strict();

export default defineGoal({
  name: 'forage',
  schema,
  destructive: true,
  description:
    'Watch for block codes (default bushes, mushrooms, crops, termite mounds), read the handbook page of ' +
    'what comes into view, harvest whatever it says yields edible food now, and eat until at least 80% ' +
    'satiety with 320 satiety in reserve. count instead stockpiles that many additional fresh items after replacing anything eaten. ' +
    'No default deadline; unavailable food keeps exploration ' +
    'running. Damage/death/control loss cancels; never respawns or resumes automatically. ' +
    'Returns START and goal.id; poll goal_status. Needs an empty hotbar slot for harvesting. ' +
    'Optional sprint=true permits straight level sprinting only while food is at least 60%.',
  announce: () => 'Foraging for a bite to eat.',
  run: (env, options) =>
    runField(env, { ...options, manageFood: true }, [], async (field, survival) => {
      await survival.tend({ force: true, watch: options.match, count: options.count, until: options.until, keep: options.keep });
      return {
        ok: true,
        goal: 'forage',
        eaten: survival.eaten,
        harvested: survival.harvested,
        retained: survival.retained,
        reserve: survival.reserve,
        moved: +field.moved.toFixed(1),
        searched: field.searched,
      };
    }),
});
