import type { Concern } from '../concern.ts';

export const PROVISIONS = 640;
export const provisions: Concern = {
  id: 'provisions',
  title: 'food carried for the night',
  done: s => s.reserve >= PROVISIONS,
  run: () => ({
    start: 'forage',
    args: { until: 0.5, keep: PROVISIONS, timeoutMs: 600000 },
    why: 'food for the night and tomorrow, eating only to half',
  }),
};
