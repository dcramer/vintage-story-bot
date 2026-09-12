import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';

export const schema = z.object({
  after: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER).optional(),
  session: z.string().max(64).optional(),
}).strict();

export default defineAction({
  name: 'events',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read buffered damage, death, respawn, low_health/food/oxygen and recovery events. Pass ' +
    'returned session/cursor as session/after. missed means resync with observe. Polling, not ' +
    'agent wakeup; health_lost does not identify attackers.',
});
