// Nothing to do but stay: a storm at home, the night at home or dug in, or a dig-in that failed here.
import type { Concern } from '../concern.ts';

export const wait: Concern = {
  id: 'wait',
  run: ({ storm, memory }) => ({ wait: storm ? 'storm' : memory.burrow ? 'night, dug in' : 'night, nowhere to go' }),
};
