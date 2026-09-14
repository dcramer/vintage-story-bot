// Sealed inside with outdoor work picked: open the door and cross its
// threshold before handing control back. Never cut short; stopping after the
// door opens can leave a lower interior floor disconnected from the next
// goal's newly observed route, which looks like a pit and damages the shell.
import { surfaceCover } from '../../../support/sites.ts';
import type { Concern } from '../concern.ts';

export const leaveShelter: Concern = {
  id: 'leave_shelter',
  uncuttable: true,
  run: ({ memory, reading }) => {
    const dwelling = memory.notes.dwelling!;
    const door = dwelling.door;
    if (dwelling.kind === 'gates')
      return {
        start: 'shelter_access',
        args: { door, home: memory.notes.home!, direction: 'leave', timeoutMs: 600000 },
        why: 'opening the door, crossing its threshold and closing it behind me',
      };
    const cells = [door, { ...door, y: door.y + 1 }];
    const outside = { ...door, z: door.z + 1 };
    if (surfaceCover(reading.terrain?.get(outside.x, outside.y, outside.z))) cells.push(outside);
    const goalScript = [
      `await goals.dig_area(${JSON.stringify({ cells, order: 'top-down', manageFood: false, sprint: false })});`,
      `await goals.move_to(${JSON.stringify({
        x: outside.x + 0.5,
        y: outside.y,
        z: outside.z + 0.5,
        dimension: 0,
        arrivalRadius: 0.35,
      })});`,
    ].join(' ');
    return {
      start: 'goal_script',
      args: { intent: 'Open the shelter and step outside', goalScript },
      why: 'opening the shelter and crossing its threshold',
    };
  },
};
