import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z
  .object({
    code: z.string().min(1).max(128).describe('Item, block or creature code, e.g. game:fruit-blueberry, game:crop-carrot-7, game:wolf-male.'),
    text: z.boolean().default(true).describe('false: the facts without the page text.'),
  })
  .strict();

export default defineAction({
  name: 'item_info',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Read the handbook page of one item, block or creature code: name, class, material, behaviors, mining tier, ' +
    'nutrition, tool class/tier, durability, bag slots, fuel, what breaking drops, what harvesting yields and the ' +
    'growth state it needs, and the page text with item links as [code]. Facts only, never what a thing is for; ' +
    'traits are derived from these. Unknown code returns ok:false.',
});
