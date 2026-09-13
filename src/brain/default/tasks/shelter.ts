// Build by day near the chest when one is noted, on observed level ground.
// A verified entry and seal make the spot home.
import type { Concern } from '../concern.ts';
import { goTo, setHome } from '../concern.ts';

// 23 blocks for walls and roof, 2 to seal the door, a small margin.
export const SHELTER_DIRT = 28;

export const shelter: Concern = {
  id: 'shelter',
  title: 'a dirt shelter to call home',
  done: s => s.home,
  after: ['dirt'],
  run: ctx => {
    const site = ctx.memory.notes.stash;
    return (
      (site && goTo(ctx, { x: site.x - 6, z: site.z }, 'the site by the chest', 3, 1)) ?? {
        start: 'shelter',
        args: { item: 'soil-', timeoutMs: 1800000 },
        why: `${ctx.k.dirt} dirt, putting up a shelter`,
      }
    );
  },
  // A finished shelter is home.
  ended: (last, memory) => {
    if (last.ok && last.result?.home) {
      setHome(memory, last.result.home);
      const origin = last.result.origin;
      if (origin) memory.notes.dwelling = { door: { x: origin.x + 1, y: origin.y, z: origin.z + 2 }, item: last.result.item ?? 'soil-' };
    }
  },
};
