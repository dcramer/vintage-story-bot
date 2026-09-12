import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { runField } from '../support/task.ts';
import { travel } from './travel.ts';

export default defineGoal({
  name: 'forage_travel',
  schema: z
    .object({
      count: z.number().int().min(1).max(256),
      match: z.array(z.string().min(1).max(32)).min(1).max(8).default(['bush']),
      x: z.number().finite(),
      z: z.number().finite(),
      arrivalRadius: z.number().min(0.5).max(8).default(3),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(3600000).optional(),
    })
    .strict(),
  destructive: true,
  description:
    'Forage until count additional fresh food items remain after anything eaten during the work, then travel to x/z at any ' +
    'surface elevation. match limits the block codes food is looked for on; default bush. Uses normal food, threat, storm, route and verification ' +
    'rules throughout. No default deadline. Returns START; poll goal_status.',
  announce: () => 'Gathering provisions, then heading home.',
  run: (env, { count, match, x, z, arrivalRadius, ...options }) =>
    runField(env, { ...options, manageFood: true }, [], async (field, survival) => {
      await survival.tend({ force: true, match, count });
      const forage = {
        count,
        harvested: survival.harvested,
        eaten: survival.eaten,
        retained: survival.retained,
        reserve: survival.reserve,
        moved: +field.moved.toFixed(1),
        searched: field.searched,
      };
      const result = await travel(field, survival, { x, z, arrivalRadius });
      return { ok: result.ok, goal: 'forage_travel', forage, travel: result };
    }),
});
