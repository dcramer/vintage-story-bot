import { z } from 'zod';

export const durationMs = z.number().int().min(1).max(2000).describe('Hold duration in milliseconds, at most 2000. Start with 250.');

export const address = z
  .object({
    inventory: z.enum(['hotbar', 'backpack', 'craftinggrid', 'mouse']),
    slot: z.number().int().min(0).max(255),
  })
  .strict();

export const expectedState = z.string().regex(/^[a-f0-9]{64}$/);

export const empty = z.object({}).strict();

export const blockTarget = z
  .string()
  .max(160)
  .regex(/^block:0:-?\d+:-?\d+:-?\d+:[a-z0-9_-]+:[a-z0-9_./-]+$/)
  .describe('Exact observed block key from scan/target; main dimension only.');
export const blockFace = z.enum(['north', 'east', 'south', 'west', 'up', 'down']);
export const blockPoint = z
  .object({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
  .strict()
  .describe('Optional observed hit/scan point inside target cell; otherwise aims at center or requested face.');

export const hand = z
  .object({
    durationMs,
    sneak: z
      .boolean()
      .optional()
      .describe('Hold sneak (shift modifier) during the action: ground placement, knapping/clay surfaces, firepit creation.'),
    expectedTarget: z.string().min(1).max(160).nullable().optional(),
    expectedState: expectedState.optional(),
    expectedItem: z
      .object({
        slot: z.number().int().min(0).max(9),
        code: z.string().min(1).max(160).nullable(),
      })
      .strict()
      .optional(),
  })
  .strict();
