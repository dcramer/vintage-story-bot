import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z.object({
  expectedGoal: z.string().uuid().optional(),
}).strict();

export default defineAction({
  name: 'stop',
  schema,
  idempotent: true,
  description:
    'Cancel shared goal and release owned inputs. Optional expectedGoal rejects stopping a ' +
    'different goal. Without guard, stops globally. Safe to repeat.',
});
