// In water: face the nearest dry ground and move with the jump key held, one stroke per decision.
import type { Decision } from '../../../runtime/brain.ts';
import { lookAt } from '../../../runtime/navigation/terrain.ts';
import type { Cell } from '../concern.ts';

export function surfacing(state: any, ground: Cell | null): Decision {
  const p = state.position;
  const yaw = ground ? lookAt(p, ground).yawDegrees : (state.orientation?.yawDegrees ?? 0);
  const oxygen = Math.round(((state.vitals?.oxygen?.current ?? 0) / (state.vitals?.oxygen?.max || 1)) * 100);
  const movement = state.motion?.swimming ? 'swimming' : 'wading';
  return {
    act: [
      { action: 'look', yawDegrees: yaw, pitchDegrees: 0 },
      { action: 'move', durationMs: 1500, direction: 'forward', jump: true, sprint: false, sneak: false },
    ],
    why: `${movement} ${ground ? `toward ${Math.round(ground.x)},${Math.round(ground.z)}` : 'ahead'}, oxygen ${oxygen}%`,
  };
}
