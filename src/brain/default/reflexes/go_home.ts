// Storm or night, away from home: walk home.
import type { Concern } from '../concern.ts';

export const goHome: Concern = {
  id: 'go_home',
  cuts: true,
  run: ({ home, storm, memory, k }) => {
    const dwelling = memory.notes.dwelling;
    if (dwelling) {
      const have = k.slots.filter(s => s.code?.includes(dwelling.item)).reduce((n, s) => n + s.quantity, 0);
      if (have < 2)
        return { start: 'harvest', args: { match: 'soil-', item: 'soil-', count: 2 - have, timeoutMs: 300000 }, why: 'blocks to close the shelter' };
      return { start: 'enter_shelter', args: { ...dwelling, home, timeoutMs: 600000 }, why: storm ? 'storm coming' : 'night falling' };
    }
    return {
      start: 'travel',
      args: { x: home!.x, z: home!.z, arrivalRadius: 3, timeoutMs: 600000 },
      why: storm ? 'storm coming' : 'night falling',
    };
  },
};
