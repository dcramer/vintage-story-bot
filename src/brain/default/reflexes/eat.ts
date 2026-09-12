// Food. Hungry (under 20%) is pressing whatever runs; peckish (under 40%) with
// nothing carried starts a search while there is strength for it. Dug in with
// food in the pack, one bite where it sits; otherwise forage to half, keeping two bites.
import type { Concern } from '../concern.ts';
import type { Situation } from '../situation.ts';

export const HUNGRY = 0.2;
// With nothing to eat in the pack, start looking while there is still strength to search.
export const PECKISH = 0.4;
export const hungry = (s: Situation) => s.hunger !== null && s.hunger < HUNGRY;
export const peckish = (s: Situation) => s.hunger !== null && s.hunger < PECKISH;

export const eat: Concern = {
  id: 'eat',
  // Peckish is not an interruption; hungry is.
  cuts: ({ s }) => hungry(s),
  run: ({ s, k, satiety }) => {
    const percent = Math.round((satiety ?? 0) * 100);
    // Sealed in for the night: one bite from the pack, no searching.
    if (s.burrowed && k.reserve > 0) return { start: 'eat', args: {}, why: `satiety ${percent}%, dug in` };
    return {
      start: 'forage',
      // Fed to half with two bites' worth kept in the pack: the pack is
      // what stops the next peckish tick from starting the same search again.
      args: { until: PECKISH + 0.1, keep: 160, timeoutMs: 1800000 },
      why: `satiety ${percent}%, ${k.reserve > 0 ? `${k.reserve} carried` : 'nothing carried'}`,
    };
  },
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
