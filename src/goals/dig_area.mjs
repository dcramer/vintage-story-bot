import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { digArea } from '../skills/build.mjs';
import { box } from '../skills/structures.mjs';
import { runField } from '../skills/task.mjs';

const cell = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();

export default defineGoal({
  name: 'dig_area',
  schema: z.object({
    cells: z.array(cell).min(1).max(12).optional().describe('Explicit cells (request size limits lists; use box for more).'),
    box: z.object({ from: cell, to: cell }).strict().optional().describe('Inclusive cuboid, at most 64 cells; dug top layer first.'),
    tool: z.string().min(1).max(64).optional().describe('Tool class to hold, e.g. Shovel; equips the lowest adequate tier.'),
    minTier: z.number().int().min(0).max(20).optional(),
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).default(600000),
  }).strict().refine(a => (a.cells !== undefined) !== (a.box !== undefined), 'Supply exactly one of cells or box')
    .refine(a => !a.box || (Math.abs(a.box.to.x - a.box.from.x) + 1) * (Math.abs(a.box.to.y - a.box.from.y) + 1) * (Math.abs(a.box.to.z - a.box.from.z) + 1) <= 64, 'box exceeds 64 cells'),
  destructive: true,
  description:
    'Dig each cell in turn: walk to a standing spot off its column, aim, dig with normal mining rules, verify. Known-air cells ' +
    'are skipped; drops are not collected (use harvest/collect_item). Reports failed cells with reasons instead of retrying. ' +
    'Never digs own footing. Returns START; poll goal_status.',
  announce: () => 'Clearing out an area.',
  run: (env, { cells, box: bounds, ...options }) => runField(env, options, ['inventory', 'block_actions'],
    (field, survival, o) => digArea(field, survival, { ...o, cells: cells ?? box(bounds.from, bounds.to) })),
});
