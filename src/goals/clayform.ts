import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { form } from '../support/forming.ts';
import { cleanName, runField } from '../support/task.ts';

export default defineGoal({
  name: 'clayform',
  schema: z.object({
    output: z.string().min(1).max(160).describe('Exact clay-forming output code, e.g. game:bowl-raw.'),
    material: z.string().min(1).max(160).optional().describe('Clay code, e.g. game:clay-blue; defaults to any owned clay.'),
    timeoutMs: z.number().int().min(1000).max(1200000).default(600000),
  }).strict(),
  destructive: true,
  description:
    'Clay-form one item: equip clay, sneak-place a clay form ahead (or reuse an unfinished own form), select the recipe, ' +
    'then aim at each missing voxel layer by layer and right-click natively (extra voxels are left-clicked away); clay is ' +
    'consumed as the game demands. Verifies inventory gain of output. Returns START; poll goal_status.',
  announce: args => `Forming ${cleanName(args.output)} out of clay.`,
  run: (env, options) => runField(env, options, ['inventory', 'sneak', 'forming'], (field, _, o) => form(field, { ...o, kind: 'clayforming' })),
});
