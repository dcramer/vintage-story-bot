import type { Concern } from '../concern.ts';
import { food, foodEnded, foodSetAside } from '../food.ts';

export const PROVISIONS = 640;
export const provisions: Concern = {
  id: 'provisions',
  title: 'food carried for the night',
  done: s => s.reserve >= PROVISIONS || (s.hunger !== null && s.hunger > 0.5),
  run: ctx => food(ctx, PROVISIONS),
  ended: foodEnded,
  setAside: foodSetAside,
};
