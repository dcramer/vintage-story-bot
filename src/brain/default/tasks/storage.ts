// Cut cattail tops, weave a reed chest, and place it in a reserved side-wall
// slot of the above-ground shelter. The first chest fixes the planned origin.

import { shelterSite } from '../../../goals/shelter.ts';
import { shelterStorage } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { goTo, selectStash } from '../concern.ts';
import { goHome } from '../reflexes/go_home.ts';

// The recipe (the game calls it a reed chest): eight lots of three cattail tops.
export const CHEST_TOPS = 24;
export const CHEST = 'game:stationarybasket-east';

export const storage: Concern = {
  id: 'storage',
  title: 'a chest at home to keep things in',
  done: s => s.storage && !s.moreStorage,
  after: ['knife'],
  run: ctx => {
    const { k, state } = ctx;
    if (k.chest) {
      const starter = ctx.memory.notes.starter;
      if (starter) {
        if (!ctx.s.atHome) return goHome.run(ctx);
        const spot = shelterStorage(starter).find(cell => {
          const block = ctx.reading.terrain?.get(cell.x, cell.y, cell.z);
          return block && !block.hazard && !block.boxes.length && (!block.code || block.code === 'game:air');
        });
        if (!spot) return { wait: 'reserved indoor chest slots are occupied or not observed' };
        return {
          start: 'build',
          args: { cells: [{ ...spot, item: k.chest }], timeoutMs: 600000 },
          why: 'a chest along the shelter wall, keeping the aisle clear',
        };
      }
      const old = ctx.memory.notes.stash;
      if (!old) {
        const pending = ctx.memory.notes.shelter;
        const origin = pending ?? shelterSite(ctx.reading.terrain, state.position);
        if (!origin) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'level ground for the chest and above-ground shelter' };
        ctx.memory.notes.shelter = origin;
        const trip = pending && goTo(ctx, { x: origin.x + 2.5, z: origin.z + 5.5 }, 'returning to the planned shelter site', 8, 2);
        if (trip) return trip;
        const spot = shelterStorage(origin).find(cell => {
          const block = ctx.reading.terrain?.get(cell.x, cell.y, cell.z);
          return block && !block.hazard && !block.boxes.length && (!block.code || block.code === 'game:air');
        });
        if (!spot) return { wait: 'reserved indoor chest slots are occupied or not observed' };
        return {
          start: 'build',
          args: { cells: [{ ...spot, item: k.chest }], timeoutMs: 600000 },
          why: 'the first chest marks its reserved place inside the planned shelter',
        };
      }
      if (old) {
        const walk = goTo(ctx, old, 'adding storage beside the supplies', 3);
        if (walk) return walk;
      }
      const p = old ?? state.position;
      const x = Math.floor(p.x),
        y = Math.floor(p.y),
        z = Math.floor(p.z);
      const spot = [
        { x: x + 1, y, z },
        { x: x - 1, y, z },
        { x, y, z: z + 1 },
        { x, y, z: z - 1 },
        { x: x + 2, y, z },
        { x: x - 2, y, z },
        { x, y, z: z + 2 },
        { x, y, z: z - 2 },
      ].find(cell => {
        const block = ctx.reading.terrain?.get(cell.x, cell.y, cell.z);
        return block && !block.hazard && !block.boxes.length && (!block.code || block.code === 'game:air');
      });
      if (!spot) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'looking for open ground beside the supplies' };
      return {
        start: 'build',
        args: { cells: [{ ...spot, item: k.chest }], timeoutMs: 600000 },
        why: 'the chest goes down here: this is the site',
      };
    }
    if (k.cattailtops >= CHEST_TOPS) return { start: 'craft_item', args: { output: CHEST, count: 1, timeoutMs: 300000 }, why: 'weaving a chest' };
    return {
      start: 'harvest',
      args: { match: 'coopersreed', item: 'cattailtops', count: CHEST_TOPS - k.cattailtops, tool: 'Knife', timeoutMs: 900000 },
      why: `${k.cattailtops}/${CHEST_TOPS} cattail tops for a chest`,
    };
  },
  ended: (last, memory, { now, state }) => {
    if (last.kind !== 'build') return;
    const built = last.ok ? last.result?.built?.find((c: any) => typeof c.code === 'string' && c.code.includes('stationarybasket')) : null;
    if (built) {
      selectStash(memory, {
        key: `block:0:${built.x}:${built.y}:${built.z}:${built.code}`,
        x: built.x,
        y: built.y,
        z: built.z,
        code: built.code,
        seen: null,
      });
      return;
    }
    // The spot is taken by something else, or the chest was not seen where it went: not again at once.
    if (last.ok) memory.tried.storage = { x: state.position.x, z: state.position.z, at: now };
  },
};
