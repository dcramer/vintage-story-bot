// A place that keeps producing scares is left behind, day or night: three scares
// within 48 blocks in a quarter hour, and the bot walks 96 blocks away from them.
import { horizontal } from '../../../runtime/navigation/terrain.ts';
import { fleeTarget } from '../../../support/threats.ts';
import type { Concern, Memory } from '../concern.ts';

export const DANGER_SCARES = 3;
export const DANGER_RADIUS = 48;
export const DANGER_MS = 15 * 60 * 1000;
export const RELOCATE_DISTANCE = 96;

export function forgetOldScares(memory: Memory, now: number) {
  memory.scares = memory.scares.filter(scare => now - scare.at < DANGER_MS);
}
export const dangerHere = (memory: Memory, position: { x: number; z: number }) =>
  memory.scares.filter(scare => horizontal(scare, position) <= DANGER_RADIUS).length >= DANGER_SCARES;

export const relocate: Concern = {
  id: 'relocate',
  cuts: true,
  run: ({ state, memory }) => {
    const away = fleeTarget(
      state.position,
      memory.scares.map(scare => ({ point: { x: scare.x, y: state.position.y, z: scare.z } })),
      RELOCATE_DISTANCE,
    );
    return {
      start: 'travel',
      args: { x: away.x, z: away.z, arrivalRadius: 8, manageFood: true, timeoutMs: 900000 },
      why: `${memory.scares.length} scares around here; moving on`,
    };
  },
  // Whatever the trip's outcome, this place has been judged; judge the new one afresh.
  ended: (_last, memory) => {
    memory.scares = [];
  },
};
