import { defineAction } from '../runtime/define.mjs';
import { empty as schema } from '../runtime/schemas.mjs';

export default defineAction({
  name: 'api',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Discover controller RPC actions, JSON input schemas and execution kinds without contacting ' +
    'the game.',
});
