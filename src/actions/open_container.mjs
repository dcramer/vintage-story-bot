import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';
import { blockTarget } from '../runtime/schemas.mjs';

export const schema = z.object({
  target: blockTarget,
}).strict();

export default defineAction({
  name: 'open_container',
  schema,
  destructive: true,
  description:
    'Right-click the aimed container block (chest, vessel, basket) through the normal input path and read ' +
    'its slots with a session token. Requires the crosshair block key from scan/inspect_target and picking ' +
    'range. Returns slots [{slot,code,quantity}] plus state for container_move. Reads the opened UI only, ' +
    'never hidden blocks. Opening another container closes the first; close_container when done. Verify ' +
    'after server sync; never blindly retry.',
});
