import { z } from 'zod';
import { defineAction } from '../action.mjs';

export default defineAction({
  name: 'set_poi',
  schema: z.object({
    name: z.string().regex(/^[a-z0-9_-]{1,32}$/),
    x: z.number().finite().optional(), y: z.number().finite().optional(), z: z.number().finite().optional(),
    note: z.string().max(120).optional(),
  }).strict().refine(a => [a.x, a.y, a.z].every(v => v === undefined) || [a.x, a.y, a.z].every(v => v !== undefined), 'Supply all of x/y/z or none'),
  description:
    'Remember a named point (default: current position) in controller memory for travel {poi}. Session-scoped, at most 64, ' +
    'lost on controller restart; no game map marker.',
});
