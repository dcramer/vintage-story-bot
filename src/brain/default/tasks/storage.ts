// The reed chest (getting-started, day 1): cattail tops cut with the knife (by
// hand they drop too, but the knife keeps the roots so the reeds grow back),
// woven into the chest the game calls a stationary basket, put down where the
// bot stands once it is made: near the cattails, and that spot is the site the
// house goes up beside. Its observed key is the note every store and take uses;
// a chest found gone is forgotten and made again.
import type { Concern } from '../concern.ts';

// The recipe (the game calls it a reed chest): eight lots of three cattail tops.
export const CHEST_TOPS = 24;
export const CHEST = 'game:stationarybasket-east';

export const storage: Concern = {
  id: 'storage',
  title: 'a chest at home to keep things in',
  done: s => s.storage,
  after: ['knife'],
  run: ({ k, state }) => {
    if (k.chest) {
      const p = state.position;
      const spot = { x: Math.floor(p.x) + 2, y: Math.floor(p.y), z: Math.floor(p.z) };
      return {
        start: 'build',
        args: { cells: [{ ...spot, item: k.chest }], timeoutMs: 600000 },
        why: 'the chest goes down here: this is the site',
      };
    }
    if (k.cattailtops >= CHEST_TOPS) return { start: 'craft_item', args: { output: CHEST, count: 1, timeoutMs: 300000 }, why: 'weaving a chest' };
    return {
      start: 'harvest',
      args: { match: 'coopersreed', item: 'cattailtops', count: CHEST_TOPS - k.cattailtops, tool: 'Knife', timeoutMs: 900000 },
      why: `${k.cattailtops}/${CHEST_TOPS} cattail tops for a chest`,
    };
  },
  ended: (last, memory, { now, state }) => {
    if (last.kind !== 'build') return;
    const built = last.ok ? last.result?.built?.find((c: any) => typeof c.code === 'string' && c.code.includes('stationarybasket')) : null;
    if (built) {
      memory.notes.stash = {
        key: `block:0:${built.x}:${built.y}:${built.z}:${built.code}`,
        x: built.x,
        y: built.y,
        z: built.z,
        code: built.code,
        seen: null,
      };
      return;
    }
    // The spot is taken by something else, or the chest was not seen where it went: not again at once.
    if (last.ok) memory.tried.storage = { x: state.position.x, z: state.position.z, at: now };
  },
};
