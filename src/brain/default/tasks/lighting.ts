import type { Concern } from '../concern.ts';
import { goHome } from '../reflexes/go_home.ts';

export const lighting: Concern = {
  id: 'lighting',
  title: 'lit shelter torches, refreshed daily',
  done: s => s.lit === true,
  after: ['shelter', 'torches'],
  run: ctx => {
    const count = (item: string) => ctx.k.slots.reduce((n, s) => n + (s.code === item ? s.quantity : 0), 0);
    if (!count('game:firestarter')) {
      if (ctx.k.sticks < 2)
        return {
          start: 'gather',
          args: { match: 'stick', item: 'game:stick', count: 2 - ctx.k.sticks, timeoutMs: 300000 },
          why: 'sticks for a firestarter',
        };
      if (!count('game:drygrass'))
        return { start: 'harvest', args: { match: 'tallgrass', item: 'drygrass', count: 1, timeoutMs: 300000 }, why: 'dry grass for a firestarter' };
      return { start: 'craft_item', args: { output: 'game:firestarter', count: 1, timeoutMs: 300000 }, why: 'a firestarter to light the shelter' };
    }
    if (!ctx.s.atHome) return goHome.run(ctx);
    const origin = ctx.memory.notes.house;
    const cells = origin
      ? [1, 8].map(dx => ({ x: origin.x + dx, y: origin.y - 1, z: origin.z + 3 }))
      : [{ x: Math.floor(ctx.home!.x), y: Math.floor(ctx.home!.y), z: Math.floor(ctx.home!.z) }];
    return { start: 'light_shelter', args: { cells, refresh: true }, why: 'freshly placed, lit torches for the shelter' };
  },
  ended: (last, memory, reading) => {
    if (last.ok && last.kind === 'light_shelter') memory.notes.lightingDay = Math.floor(reading.environment?.calendar?.totalDays ?? 0);
  },
};
