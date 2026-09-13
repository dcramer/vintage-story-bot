// Two hand baskets (getting-started, day 1): ten cattail tops each, three bag
// slots each, worn in the bag slots. Cut with the knife, woven, then moved into
// an empty bag slot before gathering tops for the next bag or chest.
import type { Concern } from '../concern.ts';

export const BAGS = 2;
export const BAG_TOPS = 10;
export const BAG = 'game:basket-normal-reed';

export function makeBag({ k, reading = undefined }) {
  const grid = reading?.inventory?.inventories?.find(i => i.name === 'craftinggrid')?.slots ?? [];
  const tops = k.cattailtops + grid.filter(s => s.slot < 9 && s.code === 'game:cattailtops').reduce((n, s) => n + s.quantity, 0);
  if (k.bagItem && k.emptyBagSlot)
    return {
      act: [{ action: 'move_item', from: k.bagItem, to: k.emptyBagSlot, quantity: 1, expectedState: k.state }],
      why: 'a hand basket into a bag slot',
    };
  if (tops >= BAG_TOPS) return { start: 'craft_item', args: { output: BAG, count: 1, timeoutMs: 300000 }, why: 'weaving a hand basket' };
  const need = BAG_TOPS;
  return {
    start: 'harvest',
    args: { match: 'coopersreed', item: 'cattailtops', count: Math.max(1, need - tops), tool: 'Knife', timeoutMs: 900000 },
    why: `${tops}/${need} cattail tops for a hand basket`,
  };
}

export const bags: Concern = {
  id: 'bags',
  title: `${BAGS} hand baskets worn`,
  done: s => s.bags >= BAGS,
  after: ['knife'],
  run: ctx => makeBag(ctx),
};
