// Open the burrow's mouth: in the morning, when hungry with nothing carried, or
// when hurt inside it. Never cut short: there is no fleeing from two blocks under.
import type { Concern } from '../concern.ts';

export const unburrow: Concern = {
  id: 'unburrow',
  uncuttable: true,
  run: ({ memory, hurt, s }) => ({
    start: 'dig_area',
    args: { cells: [memory.burrow], timeoutMs: 120000 },
    why: hurt
      ? 'burrow breached, opening escape'
      : s.besieged
        ? 'tunnel stopped by rock; opening the mouth to run'
        : s.night
          ? 'hungry, opening the burrow'
          : 'morning, opening the burrow',
  }),
  ended: (last, memory, { state }) => {
    // Removing the seal opens the shaft but does not put the body back on
    // the surface. Hand the existing dig-out goal an arbitrary direction
    // for its staircase before resuming food or kit work.
    // A failed attempt leaves the same physical seal overhead. Keep its
    // coordinates so a transient targeting or tool failure cannot strand the
    // player underground and send ordinary forage into an unreachable loop.
    if (last.ok) {
      memory.burrow = null;
      memory.pit = { x: state.position.x + 8, y: state.position.y, z: state.position.z };
    }
  },
};
