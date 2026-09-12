import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'container_slots',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Re-read the container opened by open_container: slots [{slot,code,quantity}] and the current state ' +
    'token for move_container_item. No click; errors when none is open.',
});
