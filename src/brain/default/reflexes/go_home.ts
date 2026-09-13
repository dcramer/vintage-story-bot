// Storm or night, away from home: walk home.
import type { Concern } from '../concern.ts';

export const goHome: Concern = {
  id: 'go_home',
  cuts: true,
  run: ({ home, storm, memory, k }) => {
    const dwelling = memory.notes.dwelling;
    if (dwelling) {
      const have = k.slots.filter(s => s.code?.includes(dwelling.item)).reduce((n, s) => n + s.quantity, 0);
      if (have < 2 && dwelling.item === 'game:hay-normal-ud') {
        const grass = k.slots.filter(s => s.code === 'game:drygrass').reduce((n, s) => n + s.quantity, 0);
        if (grass < (2 - have) * 8)
          return {
            start: 'harvest',
            args: { match: 'tallgrass', item: 'drygrass', count: (2 - have) * 8 - grass, timeoutMs: 300000 },
            why: 'grass to close the house',
          };
        return { start: 'craft_item', args: { output: dwelling.item, count: 2 - have, timeoutMs: 300000 }, why: 'closing the house with hay bales' };
      }
      if (have < 2)
        return { start: 'harvest', args: { match: 'soil-', item: 'soil-', count: 2 - have, timeoutMs: 300000 }, why: 'blocks to close the shelter' };
      return { start: 'enter_shelter', args: { ...dwelling, home, timeoutMs: 600000 }, why: storm ? 'storm coming' : 'night falling' };
    }
    return {
      start: 'travel',
      args: { x: home!.x, z: home!.z, y: home!.y, arrivalRadius: 0.35, timeoutMs: 600000 },
      why: storm ? 'storm coming' : 'night falling',
    };
  },
};
