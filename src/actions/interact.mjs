import { defineAction } from '../controller/define.mjs';
import { hand as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'interact',
  schema,
  destructive: true,
  description:
    'Hold right-click: use/consume/place/pickup. Set expectedTarget to the observed key to reject ' +
    'stale targets; null requires empty air. Optional expectedState/expectedItem guard inventory ' +
    'and held slot/code. Requires controlReady; background supported. Stops movement; returns START, ' +
    'not success.',
});
