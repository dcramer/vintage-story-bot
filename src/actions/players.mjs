import { defineAction } from '../runtime/define.mjs';
import { empty as schema } from '../runtime/schemas.mjs';

export default defineAction({
  name: 'players',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Other players on this server from the server-filtered tracking feed plus locally loaded player ' +
    'entities: [{name,uid,x,y,z,distance,visible}]. Positions are exact when the entity is loaded, ' +
    'tracking x/z at own height otherwise. Visible means inside the camera view cone within 64 blocks ' +
    '(directional only). Solo servers return [].',
});
