import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockPoint, blockTarget } from '../runtime/schemas.ts';
import { changeBlock } from '../support/blocks.ts';
import { runField } from '../support/task.ts';

export default defineGoal({
  name: 'dig_block',
  schema: z
    .object({
      target: blockTarget,
      point: blockPoint.optional(),
      slot: z.number().int().min(0).max(9).optional().describe('Tool/empty hotbar slot; defaults to current slot.'),
      timeoutMs: z.number().int().min(1000).max(120000).default(30000),
    })
    .strict(),
  destructive: true,
  description:
    'Aim and dig one observed block within native reach, using normal mining time/tool rules. ' +
    'Refuses own footing. No walking, tool crafting or automatic retry. Verifies target became air; ' +
    'drops/pickup are separate. Damage, movement, target/item change or deadline interrupt. ' +
    'Returns START and goal.id; poll goal_status for client-observed outcome, not server acknowledgement.',
  announce: () => 'Digging a block.',
  run: (env, options) => runField(env, options, ['block_actions'], (field, _, o) => changeBlock(field, 'dig', o)),
});
