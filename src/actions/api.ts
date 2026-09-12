import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'api',
  schema,
  readOnly: true,
  idempotent: true,
  description: 'Discover controller RPC actions, JSON input schemas and execution kinds without contacting ' + 'the game.',
});
