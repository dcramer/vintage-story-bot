import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { houseGroundwork } from '../support/house-site.ts';
import { shelterCover } from '../support/sites.ts';
import { house as houseCells, houseScaffold } from '../support/structures.ts';
import { runField } from '../support/task.ts';
import { build, digArea } from './build.ts';
import { travel } from './travel.ts';

export default defineGoal({
  name: 'house',
  schema: z
    .object({
      origin: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
      phase: z.enum(['site', 'walls', 'floor']),
      foundationItem: z.string().min(1).max(160).optional(),
      timeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
    })
    .strict(),
  destructive: true,
  description:
    'Build the getting-started 10x7 rammed-earth house shell, or dig its 8x5 interior floor down one block. Origin is a chosen level site. Existing shell blocks must match; partial construction can be resumed. Returns START; poll goal_status.',
  title: args => `House ${args.phase}`,
  announce: args =>
    args.phase === 'site'
      ? 'Clearing and leveling the house site.'
      : args.phase === 'walls'
        ? 'Building the rammed-earth house.'
        : 'Lowering the interior floor.',
  run: (env, { origin, phase, foundationItem, ...options }) =>
    runField(env, options, ['inventory', 'block_actions'], async (field, survival) => {
      const approach = await travel(field, survival, { x: origin.x + 4.5, y: origin.y, z: origin.z + 7.5, arrivalRadius: 0.6 });
      if (!approach.ok) return { ...approach, goal: 'house', phase, origin };
      if (phase === 'site') {
        const groundwork = houseGroundwork(field.env.map, origin);
        if (!groundwork) return { ok: false, goal: 'house', phase, origin, reason: 'unsafe_or_unknown_site' };
        const cleared = await digArea(field, survival, { cells: groundwork.clear, tool: undefined });
        if (!cleared.ok) return { ...cleared, goal: 'house', phase, origin };
        if (!groundwork.fill.length) return { ...cleared, ok: true, goal: 'house', phase, origin, filled: 0 };
        if (!foundationItem) return { ok: false, goal: 'house', phase, origin, reason: 'foundation_item_required' };
        const filled = await build(field, survival, {
          cells: groundwork.fill.map(cell => ({ ...cell, item: foundationItem })),
          verifyExisting: true,
        });
        return { ...filled, goal: 'house', phase, origin, cleared: cleared.dug, filled: filled.placed };
      }
      if (phase === 'walls') {
        const cover = [];
        for (let x = 0; x < 10; x++)
          for (let z = 0; z < 7; z++)
            for (let h = 0; h <= 4; h++) {
              const cell = { x: origin.x + x, y: origin.y + h, z: origin.z + z };
              if (shelterCover(field.env.map.get(cell.x, cell.y, cell.z), h)) cover.push(cell);
            }
        const outside = { x: origin.x + 4, y: origin.y, z: origin.z + 7 };
        if (shelterCover(field.env.map.get(outside.x, outside.y, outside.z), 0)) cover.push(outside);
        for (const step of houseScaffold(origin, 'game:rammed-light-plain'))
          if (shelterCover(field.env.map.get(step.x, step.y, step.z), step.y - origin.y)) cover.push(step);
        if (cover.length) {
          const cleared = await digArea(field, survival, { cells: cover, tool: undefined });
          if (!cleared.ok) return { ...cleared, goal: 'house', phase: 'site', origin };
        }
        const item = 'game:rammed-light-plain';
        const result = await build(field, survival, { cells: [...houseScaffold(origin, item), ...houseCells(origin, item)], verifyExisting: true });
        return { ...result, goal: 'house', phase, origin };
      }
      const cells = [];
      for (let x = 1; x <= 8; x++) for (let z = 1; z <= 5; z++) cells.push({ x: origin.x + x, y: origin.y - 1, z: origin.z + z });
      const result = await digArea(field, survival, { cells, tool: 'Shovel' });
      return { ...result, goal: 'house', phase, origin };
    }),
});
