import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'map_view',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read the native map id and the game server-filtered player positions. When the World Map is open, also returns ' +
    'pixel/world calibration for a real game-window capture. Terrain pixels remain in the operator-owned game map database.',
});
