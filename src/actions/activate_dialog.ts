import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z
  .object({
    dialog: z.string().min(1).max(80).describe('Dialog name from dialogs.'),
    element: z.string().min(1).max(120).describe('Button key or exact text from dialogs.'),
  })
  .strict();

export default defineAction({
  name: 'activate_dialog',
  action: 'ui_activate',
  schema,
  destructive: true,
  description:
    "Click one native dialog button by sending the GUI mouse events a real click produces at that button's center. " +
    'Exactly one open dialog and one enabled button must match; delete-world buttons are refused. Served while paused so ' +
    "blocking dialogs (character creation, death) can be dismissed; leaving the world is the operator's stop path. " +
    'Verify with dialogs/observe afterward.',
});
