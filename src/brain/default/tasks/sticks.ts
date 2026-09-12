// Ten sticks: loose ones, then branchy leaves in reach. Picked up in passing while short.
import type { Concern } from '../concern.ts';

export const STICK_MIN = 10;

export const sticks: Concern = {
  id: 'sticks',
  title: `${STICK_MIN} sticks`,
  done: s => s.sticks >= STICK_MIN,
  run: ({ k }) => ({
    start: 'gather',
    args: { match: 'stick', item: 'game:stick', count: STICK_MIN - k.sticks, timeoutMs: 600000 },
    why: `${k.sticks}/${STICK_MIN} sticks`,
  }),
  wants: k => (k.sticks < STICK_MIN ? ['stick'] : []),
};
