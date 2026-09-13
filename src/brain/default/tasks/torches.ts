// One torch for the starter shelter; two for the larger house.
import type { Concern } from '../concern.ts';

export const TORCH_MIN = 1;
const needed = s => (s.house ? 2 : TORCH_MIN);
export const TORCH = 'game:torch-basic-extinct-up';

export const torches: Concern = {
  id: 'torches',
  title: `${TORCH_MIN} torches`,
  done: s => s.torches >= needed(s),
  after: ['grass'],
  short: k => (k.torches < TORCH_MIN ? { item: 'torch-basic', count: TORCH_MIN - k.torches } : null),
  run: ({ k, s }) => {
    const need = Math.max(1, needed(s) - k.torches);
    if (k.sticks < need)
      return { start: 'gather', args: { match: 'stick', item: 'game:stick', count: need - k.sticks, timeoutMs: 300000 }, why: 'sticks for torches' };
    const grass = k.slots.filter(s => s.code === 'game:drygrass').reduce((n, s) => n + s.quantity, 0);
    const missing = Math.max(0, need - k.cattailtops) * 2 - grass;
    if (missing > 0)
      return {
        start: 'harvest',
        args: { match: 'tallgrass', item: 'drygrass', count: missing, timeoutMs: 300000 },
        why: 'enough grass to finish the torches',
      };
    return {
      start: 'craft_item',
      args: { output: TORCH, count: need, timeoutMs: 300000 },
      why: `${k.torches}/${needed(s)} torches`,
    };
  },
};
