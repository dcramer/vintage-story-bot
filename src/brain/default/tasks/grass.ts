// Dry grass for torches, once there is a home to light.
import type { Concern } from '../concern.ts';
import { TORCH_MIN } from './torches.ts';

export const grass: Concern = {
  id: 'grass',
  title: 'dry grass for torches',
  done: s => s.torches >= TORCH_MIN || s.grass > 0,
  after: ['shelter'],
  run: () => ({ start: 'harvest', args: { match: 'tallgrass', item: 'drygrass', count: 4, timeoutMs: 600000 }, why: 'grass for torches' }),
};
