import { defineGoal } from '../controller/define.mjs';
import { z } from 'zod';
import { consume } from '../skills/food.mjs';
import { runField } from '../skills/task.mjs';

export const schema = z.object({
  item: z.string().min(1).max(64).optional().describe('Only eat food whose code contains this, e.g. bread, fruit-.'),
}).strict();

export default defineGoal({
  name: 'eat',
  schema,
  destructive: true,
  description:
    'Equip and eat fresh food from own hotbar/backpack: anything whose tooltip feeds without hurting or ' +
    'altering the mind, soonest to spoil first, optionally filtered by item. Verifies both item ' +
    'consumption and increased satiety. No foraging or automatic retries. Backpack food needs ' +
    'an empty hotbar slot. Returns START and goal.id; poll goal_status for outcome.',
  announce: () => 'Stopping for a bite.',
  run: (env, options) => runField(env, options, ['food_freshness'], async field => ({ ok: true, goal: 'eat', ...await consume(field, { match: options.item }) })),
});
