import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';

export const schema = z.object({
  slot: z.number().int().min(0).max(9),
}).strict();

export default defineAction({
  name: 'select_hotbar',
  action: 'select',
  schema,
  idempotent: true,
  description:
    'Select a zero-based slot from the observed hotbar. The game validates the actual slot count. ' +
    'Ends hand actions.',
});
