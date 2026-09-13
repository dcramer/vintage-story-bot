// In water: face the nearest dry ground and move with the jump key held, one stroke per decision.
import type { Decision } from '../../../runtime/brain.ts';
import type { Cell } from '../concern.ts';

export function surfacing(state: any, ground: Cell | null): Decision {
  const oxygen = Math.round(((state.vitals?.oxygen?.current ?? 0) / (state.vitals?.oxygen?.max || 1)) * 100);
  const movement = state.motion?.swimming ? 'swimming' : 'wading';
  if (ground)
    return {
      start: 'travel',
      args: { x: ground.x, y: ground.y, z: ground.z, arrivalRadius: 0.6, timeoutMs: 120000 },
      why: `${movement} toward ${Math.round(ground.x)},${Math.round(ground.z)}, oxygen ${oxygen}%`,
    };
  const yaw = state.orientation?.yawDegrees ?? 0;
  return {
    act: [
      { action: 'look', yawDegrees: yaw, pitchDegrees: 0 },
      { action: 'move', durationMs: 1500, direction: 'forward', jump: true, sprint: false, sneak: false },
    ],
    why: `${movement} ahead, oxygen ${oxygen}%`,
  };
}
