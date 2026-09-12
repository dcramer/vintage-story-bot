// A second knife kept in the chest: the knife wears out first, and a walk home
// beats a search for flint with nothing to cut. Made like the first, then put
// away; done once the chest was seen holding one.
import type { Concern, Stash } from '../concern.ts';
import { goTo, noteContents } from '../concern.ts';
import { makeTool } from './tools.ts';

export const spareKnife: Concern = {
  id: 'spare_knife',
  title: 'a spare knife in the chest',
  done: s => s.stashKnife,
  after: ['storage', 'sticks'],
  run: ctx => {
    const { k } = ctx;
    if (k.knives < 2) return makeTool(k, 'spare knife', 'knifeblade', k.knifeBlade, 'game:knife-generic');
    const note = ctx.memory.notes.stash as Stash;
    return (
      goTo(ctx, note, 'a spare knife for the chest') ?? {
        start: 'store_items',
        args: { target: note.key, items: [{ item: 'knife-', count: 1 }], manageFood: true, timeoutMs: 600000 },
        why: 'a spare knife into the chest',
      }
    );
  },
  ended: (last, memory, { now }) => noteContents(memory, last, now),
};
