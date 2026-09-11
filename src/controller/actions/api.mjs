import { defineAction } from '../action.mjs';
import { empty as schema } from './schemas.mjs';

export default defineAction({
  name: 'api',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Discover controller RPC actions, JSON input schemas and execution kinds without contacting ' +
    'the game.',
});
