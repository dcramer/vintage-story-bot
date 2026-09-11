import { z } from 'zod';
import { defineAction } from '../action.mjs';
import { durationMs } from './schemas.mjs';

export const schema = z.object({
  durationMs,
  direction: z.enum(['forward', 'backward', 'left', 'right']).optional(),
  jump: z.boolean().optional(),
  sprint: z.boolean().optional(),
}).strict();

export default defineAction({
  name: 'move',
  schema,
  description:
    'Walk (default forward), optionally jump or sprint. Primitive inputs, no route safety checks. ' +
    'Replaces navigation/movement and stops hands. ' +
    'Requires controlReady; background walking/jumping supported. Returns START, not arrival; ' +
    'observe afterward. Damage/death and low-vital entry interrupt held inputs.',
});
