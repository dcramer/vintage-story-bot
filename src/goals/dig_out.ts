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
      force: z.boolean().default(false).describe('Gain one standing level even when a large cave has room to roam.'),
      timeoutMs: z.number().int().min(1000).max(1800000).default(600000),
    })
    .strict(),
  destructive: true,
  description:
    'Leave a confined spot: while the ground reachable from here runs out within a few dozen cells, or forced recovery needs one upward level, clear an observed low ceiling or cut a staircase ' +
    'toward x/z (the foot-level block stays as the step; the three blocks above it are dug when a carried tool or ' +
    'bare hands can break them) and climb it. With no wall, one carried soil block may form a step against observed support in empty space. ' +
    'Ends ok once there is room to roam, else with reason ' +
    'no_wall_to_cut, cannot_cut, cannot_climb or still_enclosed. Returns START; poll goal_status.',
  title: () => 'Dig a way out',
  announce: () => 'Digging my way out of this hole.',
  run: (env, options) =>
    runField(env, { ...options, avoidThreats: false }, ['inventory', 'block_actions'], (field, _, o) =>
      digOut(field, { x: o.x, z: o.z }, { steps: o.steps, force: o.force }),
    ),
});
