import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { durationMs } from '../runtime/schemas.ts';

export const schema = z
  .object({
    durationMs,
    direction: z.enum(['forward', 'backward', 'left', 'right']).optional(),
    jump: z.boolean().optional(),
    sprint: z.boolean().optional(),
    sneak: z.boolean().optional().describe('Sneak-walk; disables sprint.'),
  })
  .strict();

export default defineAction({
  name: 'move',
  schema,
  description:
    'Walk (default forward), optionally jump or sprint. Primitive inputs, no route safety checks. ' +
    'Replaces navigation/movement and stops hands. ' +
    'Requires controlReady; background walking/jumping supported. Returns START, not arrival; ' +
    'observe afterward. Damage/death and low-vital entry interrupt held inputs.',
});
