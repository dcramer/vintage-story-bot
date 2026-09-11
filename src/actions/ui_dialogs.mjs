import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'ui_dialogs',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'List open native dialogs (death, character creation, pause menu, containers) with their elements: key, type, ' +
    'text, enabled, blocksControl and window-pixel bounds. Served while paused. Use with ui_activate instead of screenshots.',
});
