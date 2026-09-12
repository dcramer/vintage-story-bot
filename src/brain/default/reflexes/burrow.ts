// Night or a storm with no home: dig in where it stands, sealed with what it
// digs. Never cut short: two blocks down is the safest place from whatever is
// coming. A finished burrow is remembered by its mouth, and one found under
// the feet at startup is recognised from the terrain.

import { dugInState } from '../../../goals/burrow.ts';
import type { Decision, Reading } from '../../../runtime/brain.ts';
import { temporalStormUnsafe } from '../../../support/fieldwork.ts';
import type { Concern, Memory } from '../concern.ts';
import { isNight } from '../situation.ts';

const STARTUP_TERRAIN_MS = 10000;

export const burrow: Concern = {
  id: 'burrow',
  cuts: true,
  uncuttable: true,
  run: () => ({ start: 'burrow', args: {}, why: 'night with no home' }),
  ended: (last, memory) => {
    if (last.ok && last.result?.mouth) memory.burrow = last.result.mouth;
  },
};

// Brain memory is fresh on each controller process, but a completed burrow is
// durable world state. Recover its mouth from the observed shaft before choosing
// work, and treat an already-open shaft as a pit to climb out of in safe daylight.
// A wait while the surroundings are still unknown; null once checked.
export function recoverBurrow(reading: Reading, memory: Memory): Decision | null {
  if (memory.startupChecked) return null;
  const { state, environment } = reading;
  const bx = Math.floor(state.position.x),
    by = Math.floor(state.position.y),
    bz = Math.floor(state.position.z),
    wet = state.motion?.swimming || state.motion?.feetInLiquid;
  const ready =
    !wet &&
    reading.terrain &&
    [
      [bx, by + 1, bz],
      [bx, by + 2, bz],
      [bx + 1, by + 1, bz],
      [bx - 1, by + 1, bz],
      [bx, by + 1, bz + 1],
      [bx, by + 1, bz - 1],
      [bx + 1, by + 2, bz],
      [bx - 1, by + 2, bz],
      [bx, by + 2, bz + 1],
      [bx, by + 2, bz - 1],
    ].every(([x, y, z]) => reading.terrain.get(x, y, z));
  if (!ready) {
    memory.startupAt ??= reading.now;
    if (reading.now - memory.startupAt < STARTUP_TERRAIN_MS) return { wait: 'inspecting surroundings after startup' };
  }
  memory.startupChecked = true;
  memory.startupAt = null;
  const observedShaft = !wet && reading.terrain ? dugInState(reading.terrain, bx, by, bz) : null;
  if (observedShaft === 'sealed' || (observedShaft === 'open' && (isNight(environment) || temporalStormUnsafe(state))))
    memory.burrow = { x: bx, y: by + 2, z: bz };
  if (observedShaft === 'open' && !memory.burrow) memory.pit = { x: state.position.x + 8, y: state.position.y, z: state.position.z };
  return null;
}
