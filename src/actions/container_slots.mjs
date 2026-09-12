import { defineAction } from '../runtime/define.mjs';
import { empty as schema } from '../runtime/schemas.mjs';

export default defineAction({
  name: 'container_slots',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Re-read the container opened by open_container: slots [{slot,code,quantity}] and the current state ' +
    'token for container_move. No click; errors when none is open.',
});
