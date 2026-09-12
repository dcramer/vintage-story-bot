import { defineAction } from '../runtime/define.ts';
import { empty as schema } from '../runtime/schemas.ts';

export default defineAction({
  name: 'inventory',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read own hotbar/backpack/mouse/crafting grid plus read-only character equipment/offhand, ' +
    'tool tiers, nutrition and durability. Grid inputs 0–8 row-major; output 9; backpack 0–3 are bag ' +
    'slots (bag: true). State token guards transferable inventories only, not equipment. Equipment/offhand ' +
    'are not transfer addresses; open containers are read by open_container. Verify mutations after server sync.',
});
