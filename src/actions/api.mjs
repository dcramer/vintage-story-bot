import { defineAction } from '../controller/define.mjs';
import { empty as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'api',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Discover controller RPC actions, JSON input schemas and execution kinds without contacting ' +
    'the game.',
});
