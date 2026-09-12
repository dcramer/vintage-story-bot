// A knife, an axe and a shovel, each its own task, the knife first: one stick
// and one flint (or a knappable stone) make a head, the head and a stick make
// the tool. Each task gathers only what its tool still lacks, so a knife is
// made the moment a flint and a stick are in hand.
import type { Decision } from '../../../runtime/brain.ts';
import type { Concern } from '../concern.ts';
import { headMaterial, type Kit, KNAPPABLE } from '../situation.ts';

// Loose flint, and the loose stones that knap; claystone and the like are not worth a stop.
const KNAPPABLE_WANTS = ['looseflints', ...KNAPPABLE.map(rock => `loosestones-${rock}`)];
const missing = (k: Kit) => [k.knife, k.axe, k.shovel].filter(have => !have).length;
// Flint to knap the tools still missing: one per head, and one more that stays in the hand
// while the recipe is chosen (placing the surface takes the first).
const flintShort = (k: Kit) => Math.max(0, missing(k) + 1 - k.knappables);

// The next act toward one tool: the stick or flint it lacks, the head, then the tool itself.
export function makeTool(k: Kit, tool: string, head: string, blades: number, output: string): Decision {
  if (blades < 1) {
    if (k.sticks < 1)
      return { start: 'gather', args: { match: 'stick', item: 'game:stick', count: 1, timeoutMs: 600000 }, why: `a stick for the ${tool}` };
    if (k.knappables < 2)
      return {
        start: 'gather',
        args: { match: 'looseflints', item: 'game:flint', count: Math.max(1, flintShort(k)), timeoutMs: 600000 },
        why: `${k.knappables} flint: two to knap the ${tool}`,
      };
    return { start: 'knap', args: { output: `game:${head}-${k.material ?? 'flint'}`, timeoutMs: 600000 }, why: `no ${tool}` };
  }
  if (k.sticks < 1)
    return { start: 'gather', args: { match: 'stick', item: 'game:stick', count: 1, timeoutMs: 600000 }, why: `a stick to haft the ${tool}` };
  return {
    start: 'craft_item',
    args: { output: `${output}-${headMaterial(k, head)}`, count: 1, timeoutMs: 300000 },
    why: `haft the ${tool} ${head === 'knifeblade' ? 'blade' : 'head'}`,
  };
}

const toolTask = (id: 'knife' | 'axe' | 'shovel', head: string, blades: (k: Kit) => number, output: string): Concern => ({
  id,
  title: `a ${id}`,
  done: s => s[id],
  run: ({ k }) => makeTool(k, id, head, blades(k), output),
  // Flint and knappable stones are picked up in passing while a tool is missing and nothing knappable is carried.
  wants: k => (!k[id] && k.knappables < 2 ? KNAPPABLE_WANTS : []),
  short: k => (!k[id] && flintShort(k) > 0 ? { item: 'game:flint', count: flintShort(k) } : null),
});

export const knife = toolTask('knife', 'knifeblade', k => k.knifeBlade, 'game:knife-generic');
export const axe = toolTask('axe', 'axehead', k => k.axeBlade, 'game:axe');
export const shovel = toolTask('shovel', 'shovelhead', k => k.shovelBlade, 'game:shovel');
