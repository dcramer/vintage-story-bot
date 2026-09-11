import { defineAction } from '../action.mjs';
import { empty as schema } from './schemas.mjs';

export default defineAction({
  name: 'eat',
  schema,
  destructive: true,
  description:
    'Equip and eat fresh allowlisted berries from own hotbar/backpack. Verifies both item ' +
    'consumption and increased satiety. No foraging or automatic retries. Backpack food needs ' +
    'an empty hotbar slot. Returns START and goal.id; poll goal_status for outcome.',
});
