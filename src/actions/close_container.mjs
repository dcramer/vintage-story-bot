import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'close_container',
  schema,
  idempotent: true,
  description:
    'Close the open container through its own sync packet. Idempotent; already-closed is fine. Call when ' +
    'done moving: open container dialogs block aiming and movement.',
});
