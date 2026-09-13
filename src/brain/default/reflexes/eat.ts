// Food recovery starts below 20% and continues to half. Eat carried food
// first, then forage or prepare roots using the current recovery strategy.

import { HUNGRY } from '../../../support/food.ts';
import type { Concern } from '../concern.ts';
import { food, foodEnded, foodRunning, foodSetAside } from '../food.ts';
import type { Situation } from '../situation.ts';

// Hungry is the goals' own line (support/food.ts), so the brain interrupts work where forage would stomach poor food.
export { HUNGRY };
export const hungry = (s: Situation) => s.hunger !== null && s.hunger < HUNGRY;

export const eat: Concern = {
  id: 'eat',
  // Peckish is not an interruption; hungry is.
  cuts: ({ s }) => hungry(s) || !!s.foodRecovery,
  run: ctx => {
    const { k, satiety } = ctx;
    const percent = Math.round((satiety ?? 0) * 100);
    if (k.reserve > 0) return { start: 'eat', args: {}, why: `satiety ${percent}%, eat carried food` };
    return food(ctx, 160);
  },
  ended: foodEnded,
  setAside: foodSetAside,
  running: foodRunning,
  // The mildly poisonous food authorized during starvation hurts; that is not an attacker.
  explains: events => events.some(event => event.type === 'message' && /^Lost [\d.]+ hp through poison$/i.test(event.text ?? '')),
  // Food where it grows is always worth a stop: berries on a ripe bush, a
  // mushroom the handbook calls edible, a wild hive's honeycomb.
  wants: () => ['fruitingbush', 'mushroom', 'wildbeehive'],
};
