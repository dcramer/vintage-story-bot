// Night with no home and a burrow that failed here (rock underfoot, nothing to seal it): a
// player walks on and digs elsewhere rather than stand in the dark. A short walk on the
// current heading, far enough that the failed spot's set-aside no longer holds.
import type { Concern } from '../concern.ts';
import { TRIED_RADIUS } from '../concern.ts';

export const SHIFT_DISTANCE = TRIED_RADIUS + 8;

export const shift: Concern = {
  id: 'shift',
  cuts: true,
  run: ({ state }) => {
    const yaw = ((state.orientation?.yawDegrees ?? 0) * Math.PI) / 180;
    return {
      start: 'travel',
      args: {
        x: state.position.x + Math.sin(yaw) * SHIFT_DISTANCE,
        z: state.position.z + Math.cos(yaw) * SHIFT_DISTANCE,
        arrivalRadius: 4,
        timeoutMs: 300000,
      },
      why: 'no burrow to be had here; digging in farther on',
    };
  },
};
