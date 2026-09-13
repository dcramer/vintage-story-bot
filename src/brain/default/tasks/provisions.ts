import type { Concern } from '../concern.ts';
import { food, foodEnded, foodSetAside } from '../food.ts';

export const PROVISIONS = 640;
export const provisions: Concern = {
  id: 'provisions',
  title: 'food carried for the night',
  // Emergency recovery owns its one food attempt. If that search is exhausted,
  // do not fall straight through into the optional provisions task.
  done: s => s.foodRecovery || s.reserve >= PROVISIONS || (s.hunger !== null && s.hunger > 0.5),
  run: ctx => food(ctx, PROVISIONS),
  // The forage goal already owns deterministic threat evasion. Keep that one
  // goal alive, while still allowing emergency hunger to preempt provisions.
  running: ({ active, danger, hurt }) => (active?.kind === 'forage' && danger && !hurt ? { wait: 'letting forage evade threat' } : null),
  ended: foodEnded,
  setAside: foodSetAside,
  // An exhausted optional search should not reopen merely because the next
  // task carried the player away from the point where forage ended.
  setAsideEverywhere: true,
};
