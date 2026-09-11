import { z } from 'zod';
import { defineAction } from '../action.mjs';

export default defineAction({
  name: 'travel',
  schema: z.object({
    x: z.number().finite().optional(),
    y: z.number().finite().optional().describe('Omit to accept any elevation.'),
    z: z.number().finite().optional(),
    poi: z.string().min(1).max(32).optional().describe('Named point from set_poi instead of coordinates.'),
    arrivalRadius: z.number().min(.5).max(8).default(1),
    manageFood: z.boolean().default(true),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).optional(),
  }).strict().refine(a => a.poi !== undefined || a.x !== undefined && a.z !== undefined, 'Supply poi or x/z'),
  destructive: true,
  description:
    'Walk any distance by chaining safe navigation legs with exploration detours through unknown terrain. Stops on ' +
    'no_progress after six stalled legs, damage, death or control loss. Food management as gather_sticks. Returns START; poll goal_status.',
});
