import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { blockFace, blockPoint, blockTarget } from '../controller/schemas.mjs';
import { changeBlock } from '../skills/blocks.mjs';
import { runField } from '../skills/task.mjs';

export default defineGoal({
  name: 'place_block',
  schema: z.object({
    target: blockTarget.describe('Observed support block key, not the destination.'),
    face: blockFace,
    point: blockPoint.optional(),
    slot: z.number().int().min(0).max(9).describe('Hotbar block stack to place.'),
    expectedItem: z.string().min(1).max(160).describe('Expected block item code in slot.'),
    timeoutMs: z.number().int().min(1000).max(30000).default(10000),
  }).strict(),
  destructive: true,
  description:
    'Aim at a support face and make one native block placement into adjacent empty, dry space. ' +
    'No replacement, walking, inventory transfer, specialized item-use or retry. Normal claims/collision ' +
    'validation applies. Verifies destination change and exactly one item consumed in survival. ' +
    'Returns START and goal.id; poll goal_status for client-observed outcome, not server acknowledgement.',
  announce: () => 'Placing a block.',
  run: (env, options) => runField(env, options, ['block_actions'], (field, _, o) => changeBlock(field, 'place', o)),
});
