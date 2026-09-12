// Enough dirt for the shelter, dug with the shovel.
import type { Concern } from '../concern.ts';
import { SHELTER_DIRT } from './shelter.ts';

export const dirt: Concern = {
  id: 'dirt',
  title: `${SHELTER_DIRT} dirt for a shelter`,
  done: s => s.home || s.dirt >= SHELTER_DIRT,
  after: ['tools'],
  run: ({ k }) => ({
    start: 'harvest',
    args: { match: 'soil-', item: 'soil-', count: Math.max(1, SHELTER_DIRT - k.dirt), tool: 'Shovel', timeoutMs: 900000 },
    why: `${k.dirt}/${SHELTER_DIRT} dirt for a shelter`,
  }),
};
