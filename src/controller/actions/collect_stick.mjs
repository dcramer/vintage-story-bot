import { defineAction } from '../action.mjs';
import { empty as schema } from './schemas.mjs';

export default defineAction({
  name: 'collect_stick',
  schema,
  destructive: true,
  description:
    'Start a shared goal to pick up one already visible/reachable loose stick, verifying ' +
    'inventory gain. Returns START and goal.id; poll observe.goal for result. No ' +
    'movement/exploration. stop cancels globally.',
});
