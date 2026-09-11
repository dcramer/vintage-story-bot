import { z } from 'zod';
import { defineAction } from '../controller/define.mjs';

export const schema = z.object({
  radius: z.number().int().min(8).max(64).optional(),
  cursor: z.string().regex(/^[a-f0-9]{32}$/).optional(),
}).strict();

export default defineAction({
  name: 'survey',
  schema,
  readOnly: true,
  description:
    'Landscape profile as the player sees it: one sight-verified surface sample per column, 360 degrees within ' +
    '8 blocks and a forward 120-degree cone to radius (default 48, max 64); every column to 16 blocks, even ' +
    'coordinates to 32, multiples of four beyond. Rows [x,z,y,kind,step,code]: y is the standing surface top, kind ' +
    'ground|canopy (ground seen through leaves)|water|hazard. Absent columns are unknown (occluded, unloaded or out of ' +
    'view), never air. Page with returned cursor and identical radius while more; expires after 30s, movement >2 ' +
    'blocks or a turn >15 degrees. Results also feed travel corridor planning. Requires controlReady; never moves the camera: ' +
    'look toward the destination first.',
  local: async (runtime, args) => {
    const page = await runtime.send({ action: 'survey', ...args });
    if (page.ok) runtime.surface.apply(page);
    return page;
  },
});
