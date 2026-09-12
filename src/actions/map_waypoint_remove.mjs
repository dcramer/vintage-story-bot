import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';

export const schema = z.object({
  guid: z.string().min(1).max(80).describe('Marker guid from map_waypoints.'),
}).strict();

export default defineAction({
  name: 'map_waypoint_remove',
  schema,
  destructive: true,
  description:
    'Delete one of the player\'s own map markers the way the map screen does (the game\'s remove command). ' +
    'Server-validated; verify by reading map_waypoints until the guid is gone. Never retry blindly.',
});
