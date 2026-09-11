import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { craftItem } from '../skills/craft.mjs';
import { cleanName, runField } from '../skills/task.mjs';

export default defineGoal({
  name: 'craft_item',
  schema: z.object({
    output: z.string().min(1).max(160).describe('Exact output item/block code, e.g. game:packeddirt.'),
    count: z.number().int().min(1).max(64).default(1).describe('Output items wanted; crafts repeat until carried gain reaches it.'),
    timeoutMs: z.number().int().min(1000).max(600000).default(120000),
  }).strict(),
  destructive: true,
  description:
    'Craft from own inventory via the 3x3 grid: pick a known recipe whose ingredients are carried, transfer them, craft into an ' +
    'empty owned slot, verify the inventory gain, repeat until count. Clears the grid first and afterwards. No knapping/clay/' +
    'container access, no gathering. missing_ingredients lists candidate recipes. Returns START; poll goal_status.',
  announce: args => `Crafting ${cleanName(args.output)}.`,
  run: (env, options) => runField(env, options, ['inventory', 'grid_craft'], (field, _, o) => craftItem(field, o)),
});
