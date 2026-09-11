import { defineAction } from '../controller/define.mjs';
import { hand as schema } from '../controller/schemas.mjs';

export default defineAction({
  name: 'attack_block',
  action: 'attack',
  schema,
  destructive: true,
  description:
    'Hold left-click on aimed block. Set expectedTarget to reject stale targets. Requires ' +
    'controlReady; background supported. Stops movement, cancels on target change. No combat. ' +
    'Returns START, not success.',
});
