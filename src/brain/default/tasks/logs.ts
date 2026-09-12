// Eight logs, felled with the axe.
import type { Concern } from '../concern.ts';

export const LOG_MIN = 8;

export const logs: Concern = {
  id: 'logs',
  title: `${LOG_MIN} logs`,
  done: s => s.logs >= LOG_MIN,
  after: ['torches'],
  run: ({ k }) => ({ start: 'fell_tree', args: { count: Math.max(1, LOG_MIN - k.logs), timeoutMs: 1200000 }, why: `${k.logs}/${LOG_MIN} logs` }),
};
