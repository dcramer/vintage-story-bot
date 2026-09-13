import type { Concern } from '../concern.ts';
import { food, foodEnded, foodSetAside } from '../food.ts';

export const PROVISIONS = 640;
export const provisions: Concern = {
  id: 'provisions',
  title: 'food carried for the night',
  done: s => s.reserve >= PROVISIONS || (s.hunger !== null && s.hunger > 0.5),
  run: ctx => food(ctx, PROVISIONS),
  // The forage goal already owns deterministic threat evasion. Keep that one
  // goal alive, while still allowing emergency hunger to preempt provisions.
  running: ({ active, danger, hurt }) => (active?.kind === 'forage' && danger && !hurt ? { wait: 'letting forage evade threat' } : null),
  ended: foodEnded,
  setAside: foodSetAside,
};
