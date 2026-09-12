import { z } from 'zod';
import { defineAction } from '../controller/define.mjs';
import { expectedState } from '../controller/schemas.mjs';

const endpoint = z.object({
  inventory: z.enum(['hotbar', 'backpack', 'craftinggrid', 'mouse', 'container']),
  slot: z.number().int().min(0).max(255),
}).strict();

export const schema = z.object({
  from: endpoint,
  to: endpoint,
  quantity: z.number().int().min(1).max(64),
  expectedState,
}).strict();

export default defineAction({
  name: 'container_move',
  schema,
  destructive: true,
  description:
    'Move items between own slots and the open container through the normal transfer path. One end must be ' +
    'the container from open_container; requires its fresh state token. May move fewer than requested. ' +
    'Verify after server sync; never blindly retry.',
});
