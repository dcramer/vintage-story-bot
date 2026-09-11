import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { travel } from '../skills/travel.mjs';
import { runField } from '../skills/task.mjs';

export default defineGoal({
  name: 'travel',
  schema: z.object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional().describe('Omit to accept any elevation.'),
    z: z.number().finite().optional(),
    waypoint: z.string().min(1).max(32).optional().describe('Named point from set_waypoint instead of coordinates.'),
    arrivalRadius: z.number().min(.5).max(8).default(1),
    manageFood: z.boolean().default(true),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict().refine(a => a.waypoint !== undefined || a.x !== undefined && a.z !== undefined, 'Supply waypoint or x/z'),
  destructive: true,
  description:
    'Walk any distance by chaining safe navigation legs with exploration detours through unknown terrain. Stops on ' +
    'no_progress after six stuck legs, damage, death or control loss. Food management as gather_sticks. Returns START; poll goal_status.',
  announce: args => args.waypoint ? `Traveling to ${args.waypoint}.` : 'Setting off on a journey.',
  // Resolves a named point from controller memory before the task starts.
  launch: (runtime, { waypoint, ...args }, record, started) => {
    const point = waypoint === undefined ? args : runtime.waypoints.get(waypoint);
    if (!point) throw Error('Unknown waypoint; see waypoints');
    const run = (env, options) => runField(env, { manageFood: true, ...options }, [], travel);
    return runtime.runTask(run, { ...args, x: point.x, y: point.y, z: point.z }, record, started);
  },
});
