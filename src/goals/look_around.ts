import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { runField } from '../support/task.ts';

// One sweep of the head from where the bot stands, then what came into view.
export default defineGoal({
  name: 'look_around',
  schema: z
    .object({
      match: z.string().min(1).max(64).optional().describe('Block code substring to watch for while turning.'),
      matches: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
      kind: z.enum(['all', 'blocks', 'items', 'entities']).default('all'),
      radius: z.number().int().min(1).max(64).default(64),
      limit: z.number().int().min(1).max(64).default(32),
      timeoutMs: z.number().int().min(1000).max(120000).default(60000),
    })
    .strict()
    .refine(value => !(value.match && value.matches), { message: 'Use match or matches, not both' }),
  description:
    'Turn the head through a full circle without moving, letting the eye take in every direction, then report what is in ' +
    'view: counts per code and the nearest objects (memory; revalidate keys before acting). match adds to the watch list ' +
    'for the sweep. Damage, death and control loss interrupt. Returns START; poll goal_status.',
  announce: () => 'Having a look around.',
  run: (env, { match, matches, kind, radius, limit, ...options }) =>
    runField(env, { manageFood: false, ...options }, [], async field => {
      const objects = await field.lookAround(matches ?? match, kind, radius);
      const codes: Record<string, number> = {};
      for (const o of objects) codes[o.code] = (codes[o.code] ?? 0) + 1;
      return {
        ok: true,
        goal: 'look_around',
        position: field.latest.position,
        heading: field.latest.orientation.yawDegrees,
        seen: objects.length,
        codes: Object.fromEntries(
          Object.entries(codes)
            .sort((a, b) => b[1] - a[1])
            .slice(0, 48),
        ),
        objects: objects.slice(0, limit),
      };
    }),
});
