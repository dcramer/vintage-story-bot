// A tiny dirt shelter (docs/brain.md) built by day where it stands; the spot becomes home.
import type { Concern } from '../concern.ts';
import { setHome } from '../concern.ts';

// 23 blocks for walls and roof, 2 to seal the door, a small margin.
export const SHELTER_DIRT = 28;

export const shelter: Concern = {
  id: 'shelter',
  title: 'a dirt shelter to call home',
  done: s => s.home,
  after: ['dirt'],
  run: ({ k }) => ({ start: 'shelter', args: { item: k.dirtCode ?? 'soil-', timeoutMs: 1800000 }, why: `${k.dirt} dirt, putting up a shelter` }),
  // A finished shelter is home.
  ended: (last, memory) => {
    if (last.ok && last.result?.home) setHome(memory, last.result.home);
  },
};
