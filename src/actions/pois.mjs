import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'pois',
  schema,
  readOnly: true,
  idempotent: true,
  description: 'List remembered points from set_poi with UTC timestamps. No game I/O.',
  local: async runtime => ({ ok: true, pois: Object.fromEntries(runtime.pois) }),
});
