import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';
import { address, expectedState } from '../runtime/schemas.mjs';

export const schema = z.object({
  to: address,
  expectedState,
  expectedOutput: z.string().min(1).max(160),
}).strict();

export default defineAction({
  name: 'craft',
  schema,
  destructive: true,
  description:
    'Craft once from prepared 3x3 grid via normal inventory transfer. Require fresh ' +
    'inventory.state/output code and empty non-grid destination fitting whole output. Server ' +
    'validates ingredients/traits/tool wear. Submitted is not confirmed; inspect input/output ' +
    'deltas afterward.',
});
