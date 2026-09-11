import { z } from 'zod';
import { defineAction } from '../controller/define.mjs';

export const schema = z.object({
  code: z.string().min(1).max(128).describe('Item or block code, e.g. game:fruit-blueberry, game:crop-carrot-7.'),
}).strict();

export default defineAction({
  name: 'item_info',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read the handbook page of one item or block code: name, nutrition, tool class/tier, durability, bag ' +
    'slots, fuel, what breaking drops, what harvesting yields and the growth state it needs, and the page ' +
    'text with item links as [code]. Facts only, never what a thing is for. Unknown code returns ok:false.',
});
