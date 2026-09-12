import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z
  .object({
    match: z.string().min(1).max(64),
    offset: z.number().int().min(0).max(100000).optional(),
    limit: z.number().int().min(1).max(8).optional(),
  })
  .strict();

export default defineAction({
  name: 'recipes',
  schema,
  readOnly: true,
  idempotent: true,
  description:
    'Search known 3x3 grid recipes by output-code substring. Default limit 4. Returns input grid ' +
    'slots/quantities and matching owned stacks (not a resource allocation plan). more supports ' +
    'offset pagination. Knapping/clay/smithing excluded.',
});
