// A tiny dirt shelter (docs/brain.md) built by day: beside the basket when one
// is noted (the shelter goal builds two blocks ahead, so it stands six blocks
// west of the basket first, clear of it), else where it stands. The spot becomes home.
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
      (site && goTo(ctx, { x: site.x - 6, z: site.z }, 'the site by the basket', 3, 1)) ?? {
        start: 'shelter',
        args: { item: ctx.k.dirtCode ?? 'soil-', timeoutMs: 1800000 },
        why: `${ctx.k.dirt} dirt, putting up a shelter`,
      }
    );
  },
  // A finished shelter is home.
  ended: (last, memory) => {
    if (last.ok && last.result?.home) setHome(memory, last.result.home);
  },
};
