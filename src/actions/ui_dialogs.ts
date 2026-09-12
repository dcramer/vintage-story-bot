import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'ui_dialogs',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'List open native dialogs (death, character creation, pause menu, containers) with their elements: key, type, ' +
    'text, enabled, blocksControl and window-pixel bounds. Served while paused. Use with ui_activate instead of screenshots.',
});
