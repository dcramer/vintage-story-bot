import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { form } from '../support/forming.ts';
import { cleanName, runField } from '../support/task.ts';

export const schema = z
  .object({
    output: z.string().min(1).max(160).describe('Exact knapping output code, e.g. game:knifeblade-flint.'),
    material: z.string().min(1).max(160).optional().describe('Knappable stone code to use; defaults to owned flint, else any owned stone.'),
    timeoutMs: z.number().int().min(1000).max(600000).default(180000),
  })
  .strict();

export default defineGoal({
  name: 'knap',
  schema,
  destructive: true,
  description:
    'Knap one item: equip the stone, sneak-place a knapping surface on the ground ahead (or reuse an unfinished own ' +
    'surface), select the recipe, then aim at each surplus voxel and left-click natively until the surface completes; ' +
    'verifies inventory gain of output. Needs an empty flat block ahead and one spare stone. Returns START; poll goal_status.',
  announce: args => `Knapping ${cleanName(args.output)}.`,
  run: (env, options) => runField(env, options, ['inventory', 'sneak', 'forming'], (field, _, o) => form(field, { ...o, kind: 'knapping' })),
});
