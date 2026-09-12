import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'close_dialog',
  action: 'ui_close',
  schema: z
    .object({
      dialog: z.string().min(1).max(80).optional().describe('Dialog name from dialogs; default: the topmost dialog that blocks control.'),
    })
    .strict(),
  idempotent: true,
  description:
    'Press Escape on one open native dialog (handbook, map, own inventory, pause menu) the way a player closes it. ' +
    'Dialogs that refuse to close (death, character creation) stay open: use dialogs and activate_dialog. Containers: ' +
    'close_container. Served while paused; verify with dialogs afterward. Requires the ui_close feature.',
});
