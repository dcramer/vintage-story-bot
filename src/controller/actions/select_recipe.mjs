import { z } from 'zod';
import { defineAction } from '../action.mjs';
import { blockTarget } from './schemas.mjs';

export default defineAction({
  name: 'select_recipe',
  schema: z.object({
    target: blockTarget.describe('Knapping surface or clay form key.'),
    recipe: z.number().int().min(0).optional().describe('Recipe id from inspect_target.forming.recipes.'),
    output: z.string().min(1).max(160).optional().describe('Alternatively the exact output code.'),
  }).strict().refine(a => (a.recipe !== undefined) !== (a.output !== undefined), 'Supply exactly one of recipe or output'),
  destructive: true,
  description:
    'Choose the recipe on an own knapping surface/clay form within reach while holding its base material, sending the ' +
    'native selection packet and closing the game dialog. Only recipes the material allows; refused once selected. ' +
    'Submitted is not confirmed: poll inspect_target.forming.recipe. Voxel work stays native (attack removes, interact adds).',
});
