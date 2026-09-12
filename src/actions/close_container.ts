import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'close_container',
  schema,
  idempotent: true,
  description:
    'Close the open container through its own sync packet. Idempotent; already-closed is fine. Call when ' +
    'done moving: open container dialogs block aiming and movement.',
});
