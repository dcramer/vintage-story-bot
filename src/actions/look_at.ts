import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';

const entityTarget = z.string().regex(/^entity:\d+$/)
  .describe('Sighted entity key from scan or nearbyEntities.');

const point = z.object({
  x: z.number().finite(), y: z.number().finite(), z: z.number().finite(),
}).strict();

export const schema = z.union([
  z.object({ target: blockTarget }).strict(),
  z.object({ target: entityTarget }).strict(),
  z.object({ entity: entityTarget }).strict(),
  point,
]);

export default defineAction({
  name: 'look_at',
  schema,
  idempotent: true,
  description:
    'Engage an easing camera lock on an observed block, sighted entity or point: one continuous look that ' +
    'tracks moving entities. The reply is one-shot; the lock persists across ticks and owns the camera, so ' +
    'movement frames should echo observed yaw. Releases on look, stop, damage, death, menus, or a lost ' +
    'target; observe.targetLock shows it. Verify aim via the observe target key before interacting.',
});
