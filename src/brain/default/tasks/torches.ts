// Two torches from the grass carried.
import type { Concern } from '../concern.ts';

export const TORCH_MIN = 2;
export const TORCH = 'game:torch-basic-extinct-up';

export const torches: Concern = {
  id: 'torches',
  title: `${TORCH_MIN} torches`,
  done: s => s.torches >= TORCH_MIN,
  after: ['grass'],
  short: k => (k.torches < TORCH_MIN ? { item: 'torch-basic', count: TORCH_MIN - k.torches } : null),
  run: ({ k }) => {
    const need = Math.max(1, TORCH_MIN - k.torches);
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
      args: { output: TORCH, count: Math.max(1, TORCH_MIN - k.torches), timeoutMs: 300000 },
      why: `${k.torches}/${TORCH_MIN} torches`,
    };
  },
};
