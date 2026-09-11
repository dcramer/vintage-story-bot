import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { retrieveBody } from '../skills/retrieve-body.mjs';
import { runField } from '../skills/task.mjs';

export default defineGoal({
  name: 'retrieve_body',
  schema: z.object({
    guid: z.string().min(1).max(80).optional().describe('Death marker guid from map_waypoints; default the latest gravestone.'),
    radius: z.number().int().min(2).max(16).default(12).describe('How far around the marker to look for dropped items.'),
    arrivalRadius: z.number().min(1).max(8).default(3),
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict(),
  destructive: true,
  description:
    'Travel to the latest "You died here" marker on the game map, pick up the dropped items around it that fit ' +
    'in an empty slot (the rest are skipped and reported; death drops despawn after 10 minutes), then delete the ' +
    'marker like the map screen would. Requires the map_waypoints mod feature. Storm, damage, death and control ' +
    'loss interrupt as travel. Returns START; poll goal_status.',
  announce: () => 'Going back for my things.',
  run: (env, options) => runField(env, { manageFood: false, ...options }, ['inventory', 'map_waypoints'], retrieveBody),
});
