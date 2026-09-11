import { defineGoal } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';
import { consume } from '../skills/food.mjs';
import { runField } from '../skills/task.mjs';

export default defineGoal({
  name: 'eat',
  schema,
  destructive: true,
  description:
    'Equip and eat fresh allowlisted berries from own hotbar/backpack. Verifies both item ' +
    'consumption and increased satiety. No foraging or automatic retries. Backpack food needs ' +
    'an empty hotbar slot. Returns START and goal.id; poll goal_status for outcome.',
  announce: () => 'Stopping for a bite.',
  run: (env, options) => runField(env, options, ['food_freshness'], async field => ({ ok: true, goal: 'eat', ...await consume(field) })),
});
