import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'map_waypoints',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'List the player\'s own markers on the game world map: index, guid, title, icon, color, position. ' +
    'The server adds a gravestone marker titled "You died here" on death. Read-only; what the map ' +
    'screen shows and nothing else. Distinct from set_waypoint/waypoints (controller memory).',
});
