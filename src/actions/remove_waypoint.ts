import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'remove_waypoint',
  schema: z.object({ name: z.string().regex(/^[a-z0-9_-]{1,32}$/) }).strict(),
  idempotent: true,
  concurrent: true,
  description: 'Forget one point remembered by set_waypoint. Controller memory only; no game I/O and no map marker.',
  local: async (runtime, { name }) => ({ ok: true, name, removed: runtime.waypoints.delete(name) }),
});
