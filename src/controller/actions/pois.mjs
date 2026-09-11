import { defineAction } from '../action.mjs';
import { empty as schema } from './schemas.mjs';

export default defineAction({
  name: 'pois',
  schema,
  readOnly: true,
  idempotent: true,
  description: 'List remembered points from set_poi with UTC timestamps. No game I/O.',
});
