import { defineAction } from '../runtime/define.ts';
import { hand as schema } from '../runtime/schemas.ts';

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
