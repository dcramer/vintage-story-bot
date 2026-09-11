import { z } from 'zod';
import { defineAction } from '../controller/define.mjs';

export const schema = z.object({
  radius: z.number().int().min(1).max(64).optional(),
  limit: z.number().int().min(1).max(32).optional(),
  kind: z.enum(['all', 'blocks', 'items', 'entities']).optional(),
  match: z.string().max(64).optional(),
  matches: z.array(z.string().min(1).max(64)).min(1).max(4).optional(),
  cursor: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict().refine(value => !(value.match && value.matches), { message: 'Use match or matches, not both' });

export default defineAction({
  name: 'scan',
  schema,
  readOnly: true,
  description:
    '360-degree surroundings to 8 blocks; forward 120x90-degree sight to radius (max 64). ' +
    'Sampled occlusion, not pixels; walls/unloaded terrain block sight. Defaults radius 8, limit ' +
    '16, kind all. match filters one substring; matches accepts 1–4 alternative substrings. Page with ' +
    'returned cursor and identical args while more; expires after 30s, ' +
    'movement >2 blocks or distant-view turn >15 degrees. incomplete marks partial knowledge even ' +
    'after last page. Requires controlReady; never moves camera.',
});
