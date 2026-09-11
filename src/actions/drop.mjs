import { z } from 'zod';
import { defineAction } from '../controller/define.mjs';
import { address, expectedState } from '../controller/schemas.mjs';

export const schema = z.object({
  from: address,
  quantity: z.number().int().min(1).max(64),
  expectedState,
}).strict();

export default defineAction({
  name: 'drop',
  schema,
  destructive: true,
  description:
    'Toss owned items from one slot onto the ground. Requires fresh ' +
    'inventory.state. Drops 1 item (quantity 1) or the whole stack (quantity at least the stack size); ' +
    'for other counts split the stack with inventory_move first. Verify after server sync; never blindly retry.',
});
