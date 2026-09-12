import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { address, expectedState } from '../runtime/schemas.ts';

export const schema = z
  .object({
    from: address,
    to: address,
    quantity: z.number().int().min(1).max(64),
    expectedState,
  })
  .strict();

export default defineAction({
  name: 'move_item',
  action: 'inventory_move',
  schema,
  destructive: true,
  description:
    'Move existing items between own slots, including crafting inputs. Requires fresh ' +
    'inventory.state. No swaps, containers, or output extraction; use craft for output. May move ' +
    'fewer than requested. Verify after server sync; never blindly retry.',
});
