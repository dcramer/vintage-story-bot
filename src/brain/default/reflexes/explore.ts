// Fed, safe, daylight, kit done: look around.
import type { Concern } from '../concern.ts';

export const explore: Concern = {
  id: 'explore',
  run: () => ({ start: 'explore', args: { legs: 2, timeoutMs: 600000 }, why: 'kit done, looking around' }),
};
