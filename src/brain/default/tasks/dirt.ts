// Enough dirt for the shelter. A shovel is faster, but bare hands still provide cover.
import type { Concern } from '../concern.ts';
import { SHELTER_DIRT } from './shelter.ts';

export const dirt: Concern = {
  id: 'dirt',
  title: `${SHELTER_DIRT} dirt for a shelter`,
  done: s => s.home || (s.buildingMaterials ?? s.dirt) >= SHELTER_DIRT,
  short: (k, s) => (!s.home && k.buildingMaterials < SHELTER_DIRT ? { item: 'soil-', count: SHELTER_DIRT - k.buildingMaterials } : null),
  run: ({ k }) => ({
    start: 'harvest',
    args: {
      match: 'soil-low-',
      item: 'soil-low-none',
      count: Math.max(1, SHELTER_DIRT - k.buildingMaterials),
      ...(k.shovel ? { tool: 'Shovel' } : {}),
      timeoutMs: 900000,
    },
    why: `${k.dirt}/${SHELTER_DIRT} dirt for a shelter`,
  }),
};
