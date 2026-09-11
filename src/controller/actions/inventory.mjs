import { defineAction } from '../action.mjs';
import { empty as schema } from './schemas.mjs';

export default defineAction({
  name: 'inventory',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read own hotbar/backpack/mouse/crafting grid plus read-only character equipment/offhand, ' +
    'tool tiers, nutrition and durability. Grid inputs 0–8 row-major; output 9. State token ' +
    'guards transferable inventories only, not equipment. Equipment/offhand are not transfer ' +
    'addresses. Verify mutations after server sync.',
});
