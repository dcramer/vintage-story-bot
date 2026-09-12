import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';

export default defineAction({
  name: 'select_recipe',
  schema: z
    .object({
      target: blockTarget.describe('Knapping surface or clay form key.'),
      recipe: z.number().int().min(0).optional().describe('Recipe id from target.forming.recipes.'),
      output: z.string().min(1).max(160).optional().describe('Alternatively the exact output code.'),
    })
    .strict()
    .refine(a => (a.recipe !== undefined) !== (a.output !== undefined), 'Supply exactly one of recipe or output'),
  destructive: true,
  description:
    'Choose the recipe on an own knapping surface/clay form within reach while holding its base material, sending the ' +
    'native selection packet and closing the game dialog. Only recipes the material allows; refused once selected. ' +
    'Submitted is not confirmed: poll target.forming.recipe. Voxel work stays native (attack removes, interact adds).',
});
