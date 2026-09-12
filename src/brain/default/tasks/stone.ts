// Flint or a knappable stone while a tool is missing. Loose flint is the usual find;
// a knappable loose stone does as well. Both are right-clicks off the ground.
import type { Concern } from '../concern.ts';
import { KNAPPABLE } from '../situation.ts';

export const stone: Concern = {
  id: 'stone',
  title: 'flint or stone to knap',
  done: s => s.stone || (s.knife && s.axe && s.shovel),
  run: () => ({ start: 'gather', args: { match: 'looseflints', item: 'game:flint', count: 2, timeoutMs: 600000 }, why: 'flint to knap' }),
  // Loose flint, and the loose stones that knap; claystone and the like are not worth a stop.
  short: k => ((!k.knife || !k.axe || !k.shovel) && !k.stone ? { item: 'game:flint', count: 2 } : null),
  wants: k => ((!k.knife || !k.axe || !k.shovel) && !k.stone ? ['looseflints', ...KNAPPABLE.map(rock => `loosestones-${rock}`)] : []),
};
