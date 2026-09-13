// Food. Hungry (under 20%) is pressing whatever runs. Dug in with food in the
// pack, eat one bite where it sits; otherwise forage to half, keeping two bites.
import { HUNGRY } from '../../../support/food.ts';
import type { Concern } from '../concern.ts';
import { food, foodEnded, foodSetAside } from '../food.ts';
import type { Situation } from '../situation.ts';

// Hungry is the goals' own line (support/food.ts), so the brain interrupts work where forage would stomach poor food.
export { HUNGRY };
export const hungry = (s: Situation) => s.hunger !== null && s.hunger < HUNGRY;

export const eat: Concern = {
  id: 'eat',
  // Peckish is not an interruption; hungry is.
  cuts: ({ s }) => hungry(s),
  run: ctx => {
    const { s, k, satiety } = ctx;
    const percent = Math.round((satiety ?? 0) * 100);
    // Sealed in for the night: one bite from the pack, no searching.
    if ((s.burrowed || s.atHome) && k.reserve > 0) return { start: 'eat', args: {}, why: `satiety ${percent}%, dug in` };
    return food(ctx, 160);
  },
  ended: foodEnded,
  setAside: foodSetAside,
  running: ({ active, danger, hurt, classifyingHurt }) => {
    if (active?.kind !== 'forage') return null;
    // Forage owns a deterministic evade-and-resume loop. Cancelling it on the
    // same sighting throws away its food leads and starts a second flight on
    // top of navigation's evasion, which is especially costly near starvation.
    // Actual damage still interrupts, as it may be from an unseen source.
    if (danger && !hurt) return { wait: 'letting forage evade threat' };
    if (danger || hurt || classifyingHurt) return null;
    // A recovery run owns food until it reaches its target, even when the last
    // carried bite briefly clears the urgent hunger alert. Cancelling it at
    // that boundary for night shelter leaves the bot peckish and restarts the
    // same forage/burrow cycle a few ticks later.
    return { wait: 'letting forage finish' };
  },
  // The mildly poisonous food authorized during starvation hurts; that is not an attacker.
  explains: events => events.some(event => event.type === 'message' && /^Lost [\d.]+ hp through poison$/i.test(event.text ?? '')),
  // Food where it grows is always worth a stop: berries on a ripe bush, a
  // mushroom the handbook calls edible, a wild hive's honeycomb.
  wants: () => ['fruitingbush', 'mushroom', 'wildbeehive'],
};
