import { z } from 'zod';
import { defineGoal } from '../controller/define.mjs';
import { build } from '../skills/build.mjs';
import { presets } from '../skills/structures.mjs';
import { runField } from '../skills/task.mjs';

const cell = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();
const item = z.string().min(1).max(160);

export default defineGoal({
  name: 'build',
  schema: z.object({
    cells: z.array(cell.extend({ item })).min(1).max(8).optional().describe('Explicit placements in order (request size limits lists).'),
    preset: z.object({
      kind: z.enum(['house', 'pit_kiln']).describe('house: getting-started 10x7 rammed-earth spec, origin = floor-level corner, long axis +x, door at x+4 on the +z wall. pit_kiln: plus around origin (the pit cell) on the surface.'),
      origin: cell,
      item: item.describe('Block item code to place, e.g. game:rammed-light-plain.'),
    }).strict().optional(),
    manageFood: z.boolean().default(false),
    sprint: z.boolean().default(false),
    timeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
  }).strict().refine(a => (a.cells !== undefined) !== (a.preset !== undefined), 'Supply exactly one of cells or preset'),
  destructive: true,
  description:
    'Place blocks cell by cell from own inventory: equip the item, stand within reach off the destination column, pick a known ' +
    'solid support face, place once and verify (one item consumed in survival). Occupied cells are skipped; failures are reported ' +
    'per cell; stops on out_of_material. No terrain clearing or scaffolding. Returns START; poll goal_status.',
  announce: args => `Building a ${(args.preset?.kind ?? 'structure').replace(/[-_]/g, ' ')}.`,
  run: (env, { cells, preset, ...options }) => runField(env, options, ['inventory', 'block_actions'],
    (field, survival) => build(field, survival, { cells: cells ?? presets[preset.kind](preset.origin, preset.item) })),
});
