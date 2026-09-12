import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'set_waypoint',
  schema: z
    .object({
      name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
      x: z.number().finite().optional(),
      y: z.number().finite().optional(),
      z: z.number().finite().optional(),
      note: z.string().max(120).optional(),
    })
    .strict()
    .refine(a => [a.x, a.y, a.z].every(v => v === undefined) || [a.x, a.y, a.z].every(v => v !== undefined), 'Supply all of x/y/z or none'),
  concurrent: true,
  description:
    'Remember a named point (default: current position) in controller memory for travel {waypoint}. Session-scoped, at most 64, ' +
    'lost on controller restart; no game map marker.',
  local: async (runtime, { name, note, ...point }) => {
    if (point.x === undefined) {
      const state = await runtime.send({ action: 'observe' });
      if (!state.ok) return state;
      point = { x: state.position.x, y: state.position.y, z: state.position.z };
    }
    runtime.waypoints.set(name, { ...point, note, at: Date.now() });
    while (runtime.waypoints.size > 64) runtime.waypoints.delete(runtime.waypoints.keys().next().value);
    return { ok: true, name, ...runtime.waypoints.get(name) };
  },
});
