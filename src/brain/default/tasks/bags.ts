// Two hand baskets (getting-started, day 1): ten cattail tops each, three bag
// slots each, worn in the bag slots. Cut with the knife, woven, then moved into
// an empty bag slot before gathering tops for the next bag or chest.
import type { Concern } from '../concern.ts';

export const BAGS = 2;
export const BAG_TOPS = 10;
export const BAG = 'game:basket-normal-reed';

export function makeBag({ k }) {
  if (k.bagItem && k.emptyBagSlot)
    return {
      act: [{ action: 'move_item', from: k.bagItem, to: k.emptyBagSlot, quantity: 1, expectedState: k.state }],
      why: 'a hand basket into a bag slot',
    };
  if (k.cattailtops >= BAG_TOPS) {
    const hotbarFree = k.slots.some(slot => slot.inventory === 'hotbar' && !slot.code);
    if (!hotbarFree) {
      const backpackFree = k.slots.find(slot => slot.inventory === 'backpack' && !slot.bag && !slot.code);
      const hotbar = k.slots.filter(slot => slot.inventory === 'hotbar');
      const spare =
        hotbar.find(slot => slot.code?.startsWith('game:flower-')) ??
        hotbar.find(slot => slot.code === 'game:rope') ??
        (k.knife && k.axe && k.shovel ? hotbar.find(slot => slot.code === 'game:flint' || slot.code?.startsWith('game:stone-')) : undefined);
      if (spare && backpackFree)
        return {
          act: [
            {
              action: 'move_item',
              from: { inventory: spare.inventory, slot: spare.slot },
              to: { inventory: backpackFree.inventory, slot: backpackFree.slot },
              quantity: spare.quantity,
              expectedState: k.state,
            },
          ],
          why: 'set aside a spare stack so the woven basket has a hotbar slot',
        };
      if (spare)
        return {
          act: [
            {
              action: 'drop',
              from: { inventory: spare.inventory, slot: spare.slot },
              quantity: spare.quantity,
              expectedState: k.state,
            },
          ],
          why: 'make a hotbar slot for the woven basket',
        };
    }
    return { start: 'craft_item', args: { output: BAG, count: 1, timeoutMs: 300000 }, why: 'weaving a hand basket' };
  }
  const need = BAG_TOPS;
  return {
    start: 'harvest',
    args: { match: 'coopersreed', item: 'cattailtops', count: Math.max(1, need - k.cattailtops), tool: 'Knife', timeoutMs: 900000 },
    why: `${k.cattailtops}/${need} cattail tops for a hand basket`,
  };
}

export const bags: Concern = {
  id: 'bags',
  title: `${BAGS} hand baskets worn`,
  done: s => s.bags >= BAGS,
  after: ['knife'],
  run: ctx => makeBag(ctx),
};
