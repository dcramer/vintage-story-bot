import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';

export const schema = z.object({
  deathId: z.string().min(1).max(80),
}).strict();

export default defineAction({
  name: 'respawn',
  schema,
  destructive: true,
  description:
    'Request normal server-validated respawn for observe.life.deathId. Requires canRespawn; ' +
    'same-death duplicates stay pending. Verify alive afterward; no auto-retry or automatic ' +
    'respawn policy.',
});
