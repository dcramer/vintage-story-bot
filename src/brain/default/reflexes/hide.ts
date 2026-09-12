// Run from a monster seen or heard, or from whatever hit it unseen: home if it is
// not right here, else straight ahead. Never cut short; over once nothing has
// shown for a while and the scare is well behind.
import { horizontal } from '../../../runtime/navigation/terrain.ts';
import { fleeTarget } from '../../../support/threats.ts';
import type { Cell, Concern } from '../concern.ts';
import { environmentalHurt, SAFE_DISTANCE, SAFE_MS } from '../situation.ts';

// Where to run when hit by something unseen: home if it is not right here, else straight ahead.
export function escapePoint(position: Cell, yawDegrees: number, home: Cell | null) {
  if (home && horizontal(position, home) > 8) return { x: home.x, z: home.z };
  const yaw = (yawDegrees * Math.PI) / 180;
  return { x: position.x + Math.sin(yaw) * 24, z: position.z + Math.cos(yaw) * 24 };
}

export const hide: Concern = {
  id: 'hide',
  cuts: true,
  uncuttable: true,
  run: ({ state, memory, now, danger, home }) => {
    memory.scares.push({ x: state.position.x, z: state.position.z, at: now });
    const away = danger ? fleeTarget(state.position, danger) : escapePoint(state.position, state.orientation?.yawDegrees ?? 0, home);
    return {
      start: 'travel',
      args: { x: away.x, z: away.z, arrivalRadius: 8, sprint: true, timeoutMs: 600000 },
      why: danger ? `${danger.code} at ${Math.round(horizontal(state.position, danger.point))} blocks` : 'hurt by something unseen',
    };
  },
  running: ({ state, memory, now, events, danger, hurt, classifyingHurt }) => {
    // Damage chat can trail the life event by one brain tick. If gravity is
    // identified only after the reflex already launched a flight, end that
    // mistaken flight and return to the interrupted survival job.
    if (!danger && environmentalHurt(events)) return { stop: 'fall' };
    // A flight is over once nothing has been seen or heard for a while and the scare is well behind.
    const scare = memory.scares.at(-1);
    if (!danger && !hurt && !classifyingHurt && scare && now - scare.at > SAFE_MS && horizontal(state.position, scare) >= SAFE_DISTANCE)
      return { stop: 'safe' };
    return null;
  },
};
