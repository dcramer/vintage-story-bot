import { defineAction } from '../action.mjs';
import { empty as schema } from './schemas.mjs';

export default defineAction({
  name: 'observe',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read identity/world, position, orientation, vitals, body condition/nutrition/temporal-storm phase, motion, ' +
    'target, inventory and action timers. Missing condition values are null, not healthy/zero. ' +
    'engineMotion uses native units, not blocks/sec. Observe before/after actions.',
});
