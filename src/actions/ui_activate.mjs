import { z } from 'zod';
import { defineAction } from '../controller/define.mjs';

export const schema = z.object({
  dialog: z.string().min(1).max(80).describe('Dialog name from ui_dialogs.'),
  element: z.string().min(1).max(120).describe('Button key or exact text from ui_dialogs.'),
}).strict();

export default defineAction({
  name: 'ui_activate',
  schema,
  destructive: true,
  description:
    'Click one native dialog button by sending the GUI mouse events a real click produces at that button\'s center. ' +
    'Exactly one open dialog and one enabled button must match; delete-world buttons are refused. Works before F7 ' +
    'opt-in so blocking dialogs (character creation, death) can be dismissed; verify with ui_dialogs/observe afterward.',
});
