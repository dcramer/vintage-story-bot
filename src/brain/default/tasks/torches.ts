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
  run: ({ k }) => ({
    start: 'craft_item',
    args: { output: TORCH, count: Math.max(1, TORCH_MIN - k.torches), timeoutMs: 300000 },
    why: `${k.torches}/${TORCH_MIN} torches`,
  }),
};
