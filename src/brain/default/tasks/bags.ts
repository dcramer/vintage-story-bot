// Two hand baskets (getting-started, day 1): ten cattail tops each, three bag
// slots each, worn in the bag slots. Cut with the knife, woven, then moved into
// an empty bag slot by hand; the chest's tops are cut in the same trip.
import type { Concern } from '../concern.ts';
import { BASKET_TOPS } from './storage.ts';

export const BAGS = 2;
export const BAG_TOPS = 10;
export const BAG = 'game:basket-normal-reed';

export const bags: Concern = {
  id: 'bags',
  title: `${BAGS} hand baskets worn`,
  done: s => s.bags >= BAGS,
  after: ['knife'],
  run: ({ k, s, reading }) => {
    if (k.bagItem && k.emptyBagSlot)
      return {
        act: [{ action: 'move_item', from: k.bagItem, to: k.emptyBagSlot, quantity: 1, expectedState: k.state }],
        why: 'a hand basket into a bag slot',
      };
    if (k.cattailtops >= BAG_TOPS) return { start: 'craft_item', args: { output: BAG, count: 1, timeoutMs: 300000 }, why: 'weaving a hand basket' };
    // One trip to the reeds for the baskets and the chest together.
    const need = (BAGS - k.bags) * BAG_TOPS + (s.storage ? 0 : BASKET_TOPS);
    return {
      start: 'harvest',
      args: { match: 'coopersreed', item: 'cattailtops', count: Math.max(1, need - k.cattailtops), tool: 'Knife', timeoutMs: 900000 },
      why: `${k.cattailtops}/${need} cattail tops for baskets`,
    };
  },
};
