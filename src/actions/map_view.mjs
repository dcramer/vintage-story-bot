import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'map_view',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read pixel/world calibration from the currently open native World Map. Returns opened:false when it is closed. ' +
    'This is operator support for placing telemetry over a real game-window capture; it does not read terrain pixels.',
});
