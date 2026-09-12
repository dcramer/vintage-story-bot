// Storm or night, away from home: walk home.
import type { Concern } from '../concern.ts';

export const goHome: Concern = {
  id: 'go_home',
  cuts: true,
  run: ({ home, storm }) => ({
    start: 'travel',
    args: { x: home!.x, z: home!.z, arrivalRadius: 3, timeoutMs: 600000 },
    why: storm ? 'storm coming' : 'night falling',
  }),
};
