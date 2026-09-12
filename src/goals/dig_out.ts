import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { digOut } from '../support/digging.ts';
import { runField } from '../support/task.ts';

export default defineGoal({
  name: 'dig_out',
  schema: z
    .object({
      x: z.number().finite().describe('Where the bot was trying to go; the stairs head that way.'),
      z: z.number().finite(),
      steps: z.number().int().min(1).max(16).default(8),
      timeoutMs: z.number().int().min(1000).max(1800000).default(600000),
    })
    .strict(),
  destructive: true,
  description:
    'Climb out of a hole: while the ground reachable from here runs out within a few dozen cells, cut a staircase ' +
    'toward x/z (the foot-level block stays as the step; the three blocks above it are dug when a carried tool or ' +
    'bare hands can break them) and climb it. Ends ok once there is room to roam, else with reason ' +
    'no_wall_to_cut, cannot_cut, cannot_climb or still_enclosed. Returns START; poll goal_status.',
  announce: () => 'Digging my way out of this hole.',
  run: (env, options) =>
    runField(env, options, ['inventory', 'block_actions'], (field, _, o) => digOut(field, { x: o.x, z: o.z }, { steps: o.steps })),
});
