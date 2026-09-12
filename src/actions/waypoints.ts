import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'waypoints',
  schema,
  readOnly: true,
  idempotent: true,
  description: 'List remembered points from set_waypoint with UTC timestamps. No game I/O.',
  local: async runtime => ({ ok: true, waypoints: Object.fromEntries(runtime.waypoints) }),
});
