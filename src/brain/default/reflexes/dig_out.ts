// In a hole: cut stairs the way the walk was heading, before any job. Never cut
// short; a partial staircase is progress worth repeating, a run that climbed
// nothing forgets the pit rather than restarting every tick.
import type { Reading } from '../../../runtime/brain.ts';
import type { Concern, Ended, Memory } from '../concern.ts';
import { failedOnItsOwn } from '../concern.ts';

// The action RPC can reject a changed block after a successful step and omit the result;
// only then is the observed height taken as progress.
const climbed = (last: Ended, memory: Memory, { state }: Reading) =>
  last.result ? last.result.climbed > 0 : !!memory.pit && state.position.y > memory.pit.y + 0.5;

export const digOut: Concern = {
  id: 'dig_out',
  uncuttable: true,
  run: ({ memory }) => ({ start: 'dig_out', args: { x: memory.pit!.x, z: memory.pit!.z }, why: 'in a hole' }),
  setAside: (last, memory, reading) => !climbed(last, memory, reading) && failedOnItsOwn(last),
  ended: (last, memory, reading) => {
    if (last.ok || !climbed(last, memory, reading)) memory.pit = null;
  },
};
