import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'can_see',
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
  readOnly: true,
  description:
    'Whether a line of sight from the eye reaches one cell right now: within 8 blocks in any direction, farther only inside ' +
    'the field of view and the light-limited radius (64 by day). known:false with reason outside_view or unloaded means unknown, ' +
    'not hidden; blockedBy is the cell in the way. One ray, not a search. Requires the can_see feature.',
});
