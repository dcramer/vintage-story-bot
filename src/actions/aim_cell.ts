import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export default defineAction({
  name: 'aim_cell',
  schema: z.object({
    x: z.number().int(),
    y: z.number().int(),
    z: z.number().int(),
    face: z.enum(['north', 'east', 'south', 'west', 'up', 'down']).optional()
      .describe('Face of the block to aim at; omitted aims at the block centre.'),
    voxel: z.tuple([z.number().int().min(0).max(15), z.number().int().min(0).max(15), z.number().int().min(0).max(15)]).optional()
      .describe('Aim at a 0-15 voxel on a knapping/clay surface instead of a face.'),
  }).strict(),
  description:
    'Aim the camera at a cell by coordinates using the block\'s real selection-box geometry, instead of caller-computed ' +
    'angles. Requires controlReady; cell within 8 blocks and loaded. Verify with inspect_target after a frame. Returns applied angles.',
});
