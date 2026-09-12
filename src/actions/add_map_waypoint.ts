import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'add_map_waypoint',
  action: 'map_waypoint_add',
  schema: z
    .object({
      title: z.string().min(1).max(64),
      x: z.number().finite().optional().describe('Defaults to the current position with y and z.'),
      y: z.number().finite().optional(),
      z: z.number().finite().optional(),
      icon: z
        .string()
        .regex(/^[a-z0-9_-]{1,32}$/)
        .optional()
        .describe('Map icon name (circle, bee, cave, home, ladder, pick, rocks, ruins, spiral, star1, star2, trader, vessel…); default circle.'),
      color: z
        .string()
        .regex(/^(#[0-9a-fA-F]{6}|[a-z]{1,24})$/)
        .optional()
        .describe('#rrggbb or a color name; default #ff0000.'),
      pinned: z.boolean().optional(),
    })
    .strict()
    .refine(a => [a.x, a.y, a.z].every(v => v === undefined) || [a.x, a.y, a.z].every(v => v !== undefined), 'Supply all of x/y/z or none'),
  destructive: true,
  description:
    "Add a marker to the player's own game map the way the map screen does (the game's add command), at x/y/z or where the bot " +
    'stands. Server-validated; verify by reading map_waypoints until a marker with the title appears. Never retry blindly. ' +
    'Distinct from set_waypoint (controller memory). Requires the map_waypoint_add feature.',
  local: async (runtime, { x, y, z, ...rest }) => {
    let at = { x, y, z };
    if (x === undefined) {
      const state = await runtime.send({ action: 'observe' });
      if (!state.ok) return state;
      at = { x: state.position.x, y: state.position.y, z: state.position.z };
    }
    return runtime.send({ action: 'map_waypoint_add', ...rest, ...at });
  },
});
