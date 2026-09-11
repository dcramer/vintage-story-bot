import { defineAction } from '../action.mjs';
import { hand as schema } from './schemas.mjs';

export default defineAction({
  name: 'interact',
  schema,
  destructive: true,
  description:
    'Hold right-click: use/consume/place/pickup. Set expectedTarget to the observed key to reject ' +
    'stale targets. Requires controlReady; background supported. Stops movement; returns START, ' +
    'not success.',
});
