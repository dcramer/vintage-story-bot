// Food recovery starts below 20% and continues to half. Eat carried food
// first, then forage or prepare roots using the current recovery strategy.

import { horizontal } from '../../../runtime/navigation/terrain.ts';
import { HUNGRY } from '../../../support/food.ts';
import type { Concern } from '../concern.ts';
import { food, foodEnded, foodSetAside, LOCAL_COOKING_DISTANCE, nearbyCooking } from '../food.ts';
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
  running: ctx => {
    const { active, danger, hurt, classifyingHurt, s, k, memory, state } = ctx;
    if (active?.kind === 'harvest' && k.free === 0 && !k.slots.some(slot => slot.code === 'game:cattailroot'))
      return { stop: 'make room for food before continuing the harvest' };
    if (
      active?.kind === 'travel' &&
      s.hunger !== null &&
      s.hunger < 0.1 &&
      !memory.notes.cooking &&
      memory.notes.firepit &&
      horizontal(state.position, memory.notes.firepit) > LOCAL_COOKING_DISTANCE &&
      !danger &&
      !hurt
    )
      return { stop: 'prepare a local cooking fire while starving' };
    if (active?.kind === 'fell_tree' && s.hunger !== null && s.hunger < 0.1 && k.logs > 0 && !danger && !hurt)
      return { stop: 'prepare cooking fuel from the log already carried' };
    if (active?.kind === 'cook' && danger && !hurt && !classifyingHurt && !s.threatNear)
      return { wait: 'finishing critical cooking while the threat stays at a distance' };
    if (active?.kind !== 'forage') return null;
    if (!danger && !hurt && !classifyingHurt && nearbyCooking(ctx)) return { stop: 'check food left in the nearby firepit' };
    // A raw-forage pass begun above the emergency line must hand control back
    // as soon as satiety crosses it. The next decision can then prepare the
    // existing one-root fallback instead of spending the remaining margin on
    // the forage search.
    if (
      s.hunger !== null &&
      s.hunger < 0.1 &&
      (memory.notes.cookUntil ?? 0) > 0 &&
      !ctx.tried.has(ctx.job) &&
      !memory.notes.deferredCooking?.length &&
      !danger &&
      !hurt &&
      !classifyingHurt
    )
      return { stop: 'prepare emergency roots' };
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
