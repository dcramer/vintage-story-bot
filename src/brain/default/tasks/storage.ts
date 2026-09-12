// A basket by the door to keep things in: cattail tops cut with the knife, woven
// into a stationary basket, put down beside the shelter. Its observed key is the
// note every store and take uses; a basket found gone is forgotten and made again.
import type { Concern } from '../concern.ts';
import { goTo, stashSpot } from '../concern.ts';

// The recipe: four lots of three cattail tops.
export const BASKET_TOPS = 12;
export const BASKET = 'game:stationarybasket-east';

export const storage: Concern = {
  id: 'storage',
  title: 'a basket at home to keep things in',
  done: s => s.storage,
  after: ['shelter'],
  run: ctx => {
    const { k, home } = ctx;
    if (k.basket) {
      const spot = stashSpot(home!);
      return (
        goTo(ctx, spot, 'a basket to put down at home') ?? {
          start: 'build',
          args: { cells: [{ ...spot, item: k.basket }], timeoutMs: 600000 },
          why: 'a basket by the door',
        }
      );
    }
    if (k.cattailtops >= BASKET_TOPS) return { start: 'craft_item', args: { output: BASKET, count: 1, timeoutMs: 300000 }, why: 'weaving a basket' };
    return {
      start: 'harvest',
      args: { match: 'coopersreed', item: 'cattailtops', count: BASKET_TOPS - k.cattailtops, tool: 'Knife', timeoutMs: 900000 },
      why: `${k.cattailtops}/${BASKET_TOPS} cattail tops for a basket`,
    };
  },
  ended: (last, memory, { now, state }) => {
    if (last.kind !== 'build') return;
    const built = last.ok ? last.result?.built?.find((c: any) => typeof c.code === 'string' && c.code.includes('stationarybasket')) : null;
    if (built) {
      memory.notes.stash = {
        key: `block:0:${built.x}:${built.y}:${built.z}:${built.code}`,
        x: built.x,
        y: built.y,
        z: built.z,
        code: built.code,
        seen: null,
      };
      return;
    }
    // The spot is taken by something else, or the basket was not seen where it went: not again at once.
    if (last.ok) memory.tried.storage = { x: state.position.x, z: state.position.z, at: now };
  },
};
