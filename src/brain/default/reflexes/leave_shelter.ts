// Sealed inside with outdoor work picked: open the door to leave. Never cut
// short; a half-opened door is cover lost for nothing.
import { surfaceCover } from '../../../support/sites.ts';
import type { Concern } from '../concern.ts';

export const leaveShelter: Concern = {
  id: 'leave_shelter',
  uncuttable: true,
  run: ({ memory, reading }) => {
    const door = memory.notes.dwelling!.door;
    const cells = [door, { ...door, y: door.y + 1 }];
    const outside = { ...door, z: door.z + 1 };
    if (surfaceCover(reading.terrain?.get(outside.x, outside.y, outside.z))) cells.push(outside);
    return { start: 'dig_area', args: { cells, timeoutMs: 120000 }, why: 'opening the shelter to leave' };
  },
};
