// Build by day near the chest when one is noted, on observed level ground.
// A verified entry and seal make the spot home.

import { shelterSite } from '../../../goals/shelter.ts';
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
    const pending = ctx.memory.notes.shelter;
    if (pending) {
      const trip = goTo(ctx, { x: pending.x + 1.5, z: pending.z + 3.5 }, 'finishing the shelter', 5, 2);
      if (trip) return trip;
    }
    const site = ctx.memory.notes.stash;
    const trip = !pending && site && goTo(ctx, { x: site.x - 6, z: site.z }, 'the site by the chest', 3, 1);
    if (trip) return trip;
    const origin = pending ?? shelterSite(ctx.reading.terrain, ctx.state.position);
    if (!origin) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking for supported shelter ground' };
    ctx.memory.notes.shelter = origin;
    return { start: 'shelter', args: { origin, item: 'soil-', timeoutMs: 1800000 }, why: `${ctx.k.dirt} dirt, finishing the shelter` };
  },
  // A finished shelter is home.
  ended: (last, memory) => {
    if (last.ok && last.result?.home) {
      memory.notes.shelter = null;
      setHome(memory, last.result.home);
      const origin = last.result.origin;
      if (origin) memory.notes.dwelling = { door: { x: origin.x + 1, y: origin.y, z: origin.z + 2 }, item: last.result.item ?? 'soil-' };
    }
  },
};
