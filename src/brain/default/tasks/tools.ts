// A knife, an axe and a shovel: heads knapped from what is carried and hafted
// into the tool of the same material, one tool per goal.
import type { Decision } from '../../../runtime/brain.ts';
import type { Concern } from '../concern.ts';
import { headMaterial, type Kit } from '../situation.ts';

const make = (k: Kit, tool: string, head: string, blades: number, output: string): Decision =>
  blades < 1
    ? { start: 'knap', args: { output: `game:${head}-${k.material ?? 'flint'}`, timeoutMs: 600000 }, why: `no ${tool}` }
    : {
        start: 'craft_item',
        args: { output: `${output}-${headMaterial(k, head)}`, count: 1, timeoutMs: 300000 },
        why: `haft the ${tool} ${head === 'knifeblade' ? 'blade' : 'head'}`,
      };

export const tools: Concern = {
  id: 'tools',
  title: 'a knife, an axe and a shovel',
  done: s => s.knife && s.axe && s.shovel,
  after: ['sticks', 'stone'],
  run: ({ k }) => {
    if (!k.knife) return make(k, 'knife', 'knifeblade', k.knifeBlade, 'game:knife-generic');
    if (!k.axe) return make(k, 'axe', 'axehead', k.axeBlade, 'game:axe');
    return make(k, 'shovel', 'shovelhead', k.shovelBlade, 'game:shovel');
  },
};
