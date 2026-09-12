import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z
  .object({
    id: z.string().uuid().optional(),
  })
  .strict();

export default defineAction({
  name: 'goal_status',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read a goal by id (default latest), progress/result and controller session without ' +
    'contacting the game. Last 64 goals retained until controller restart. active stays true ' +
    'through cleanup; unknown id is not success.',
});
