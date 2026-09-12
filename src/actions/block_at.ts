import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

// One cell as the bot remembers it: the surroundings say whether it is air,
// solid or a hazard, and what block it is; a block sighting adds its facts; the far
// view adds the ground seen in its column. Never a world read: absent memory is unknown.
export default defineAction({
  name: 'block_at',
  schema: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
  readOnly: true,
  description:
    'What is remembered about one cell: kind unknown|air|solid|hazard from the surroundings seen within 8 blocks (traits such as ' +
    'leaves, plant, water; code of the block; ageMs since seen), block {key, code, facts, traits, access} when a block was sighted there, and column ' +
    '{y, kind, code} when the far view saw that ground. unknown is never air: look at the cell to learn it. Memory only.',
  local: async (runtime, { x, y, z }) => {
    await runtime.snapshot();
    const wall = Date.now();
    const cell = runtime.map.get(x, y, z);
    const sighting = runtime.sightings.blockAt({ x, y, z });
    const column = runtime.surface.get(x, z);
    return {
      ok: true,
      x,
      y,
      z,
      kind: !cell ? 'unknown' : cell.hazard ? 'hazard' : cell.boxes.length ? 'solid' : 'air',
      hazard: cell?.hazard ?? null,
      traits: cell?.traits ?? [],
      code: cell?.code ?? null,
      ageMs: cell ? Math.max(0, wall - cell.seenAt) : null,
      block: sighting
        ? {
            key: sighting.key,
            code: sighting.code,
            facts: sighting.extra?.facts ?? null,
            traits: runtime.sightings.traits({ kind: 'block', code: sighting.code, facts: sighting.extra?.facts }),
            access: sighting.extra?.access ?? null,
            visible: sighting.visible,
            ageMs: sighting.visible ? 0 : Math.max(0, wall - sighting.seenAt),
          }
        : null,
      column: column ? { y: column.y, kind: column.kind, code: column.code ?? null, ageMs: Math.max(0, wall - column.seenAt) } : null,
    };
  },
});
