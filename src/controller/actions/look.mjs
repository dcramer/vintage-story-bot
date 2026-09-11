import { z } from 'zod';
import { defineAction } from '../action.mjs';

export const schema = z.object({
  yawDegrees: z.number().min(-36000).max(36000),
  pitchDegrees: z.number().min(-89).max(89),
}).strict();

export default defineAction({
  name: 'look',
  schema,
  idempotent: true,
  description:
    'Set absolute look angles in degrees. Pitch is negative up, zero level, positive down. Ends ' +
    'hand actions. Wait at least one rendered frame before observing the new target.',
});
