import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { travel } from '../skills/travel.mjs';
import { runField } from '../skills/task.mjs';

const task = (env, options) => runField(env, { manageFood: false, ...options }, [], travel);
const resolve = (runtime, { waypoint, ...args }) => {
  const point = waypoint === undefined ? args : runtime.waypoints.get(waypoint);
  if (!point) throw Error('Unknown waypoint; see waypoints');
  return { ...args, x: point.x, y: point.y, z: point.z };
};

export default defineGoal({
  name: 'travel',
  schema: z.object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional().describe('Omit to accept any elevation.'),
    z: z.number().finite().optional(),
    waypoint: z.string().min(1).max(32).optional().describe('Named point from set_waypoint instead of coordinates.'),
    arrivalRadius: z.number().min(.5).max(8).default(1),
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict().refine(a => a.waypoint !== undefined || a.x !== undefined && a.z !== undefined, 'Supply waypoint or x/z'),
  destructive: true,
  description:
    'Walk any distance by chaining safe navigation legs with exploration detours through unknown terrain. Stops on ' +
    'no_progress after six stuck legs, damage, death or control loss. Food management as gather_sticks. Returns START; poll goal_status.',
  announce: args => args.waypoint ? `Traveling to ${args.waypoint}.` : 'Setting off on a journey.',
  compose: (runtime, env, args) => task(env, resolve(runtime, args)),
  // Resolves a named point from controller memory before the task starts.
  launch: (runtime, args, record, started) => runtime.runTask(task, resolve(runtime, args), record, started),
});
