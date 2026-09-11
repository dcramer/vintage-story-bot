import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'waypoints',
  schema,
  readOnly: true,
  idempotent: true,
  description: 'List remembered points from set_waypoint with UTC timestamps. No game I/O.',
  local: async runtime => ({ ok: true, waypoints: Object.fromEntries(runtime.waypoints) }),
});
