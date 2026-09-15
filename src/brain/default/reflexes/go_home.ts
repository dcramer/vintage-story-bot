// Storm or night, away from home: walk home.

import { horizontal } from '../../../runtime/navigation/terrain.ts';
import { shelterCover } from '../../../support/sites.ts';
import { shelter as blueprint, SHELTER_MATERIAL, shelterDoor, shelterScaffold, shelterTorches } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { goTo } from '../concern.ts';
import { shelter } from '../tasks/shelter.ts';

export const goHome: Concern = {
  id: 'go_home',
  cuts: true,
  run: ctx => {
    const { home, storm, memory, k, state, reading } = ctx;
    const pending = memory.notes.shelter;
    const distance = pending ? horizontal(state.position, { x: pending.x + 2.5, z: pending.z + 2.5 }) : Infinity;
    if (!storm && pending && home && horizontal(state.position, home) > distance + 32 && distance <= 64) {
      const cells = [
        ...shelterScaffold(pending, SHELTER_MATERIAL),
        ...blueprint(pending, SHELTER_MATERIAL),
        ...shelterDoor(pending, SHELTER_MATERIAL),
      ];
      const observed = cells.map(c => reading.terrain?.get(c.x, c.y, c.z));
      const missing = observed.filter(block => block?.code !== SHELTER_MATERIAL).length;
      const supplies = item => k.slots.filter(s => s.code === item).reduce((n, s) => n + s.quantity, 0);
      const clear = observed.every(
        (block, i) =>
          block && (!block.code || block.code === 'game:air' || block.code === SHELTER_MATERIAL || shelterCover(block, cells[i].y - pending.y)),
      );
      const torch = k.torches > 0 || shelterTorches(pending).every(c => reading.terrain?.get(c.x, c.y, c.z)?.code?.startsWith('game:torch-basic-'));
      if (clear && missing <= 8 && supplies(SHELTER_MATERIAL) >= missing && torch && supplies('game:firestarter') > 0) return { handoff: 'shelter' };
    }
    const dwelling = memory.notes.dwelling;
    if (dwelling) {
      // A task handoff only needs the bot home; sealing the door is for a stay
      // the night or storm rungs chose themselves. Near the door the task needs
      // the inside, so the walk falls through to the seal below. Unset in
      // synthetic readings behaves as a direct call.
      if (home && ctx.job !== undefined && ctx.job !== 'go_home') {
        // A closed shelter makes its interior home point unreachable to the
        // ordinary navigator. Target the known outside of the doorway first;
        // otherwise travel can circle or climb the roof while trying to reach
        // a point behind the closed gates. Once near, the existing access goal
        // opens the gates and crosses the threshold deliberately.
        const doorstep = { x: dwelling.door.x + 0.5, y: dwelling.door.y, z: dwelling.door.z + 1.5 };
        const walk = goTo(ctx, doorstep, 'returning to the shelter door for the task');
        if (walk) return walk;
      }
      if (dwelling.kind === 'gates')
        return {
          start: 'shelter_access',
          args: { door: dwelling.door, home, direction: 'enter', timeoutMs: 600000 },
          why: storm ? 'storm coming' : 'night falling',
        };
      const have = k.slots.filter(s => s.code?.includes(dwelling.item)).reduce((n, s) => n + s.quantity, 0);
      if (have < 2 && dwelling.item === 'game:hay-normal-ud') {
        const grass = k.slots.filter(s => s.code === 'game:drygrass').reduce((n, s) => n + s.quantity, 0);
        if (grass < (2 - have) * 8)
          return {
            start: 'harvest',
            args: { match: 'tallgrass', item: 'drygrass', count: (2 - have) * 8 - grass, tool: 'Knife', timeoutMs: 300000 },
            why: 'grass to close the house',
          };
        return { start: 'craft_item', args: { output: dwelling.item, count: 2 - have, timeoutMs: 300000 }, why: 'closing the house with hay bales' };
      }
      if (have < 2)
        return { start: 'harvest', args: { match: 'soil-', item: 'soil-', count: 2 - have, timeoutMs: 300000 }, why: 'blocks to close the shelter' };
      return { start: 'enter_shelter', args: { ...dwelling, home, timeoutMs: 600000 }, why: storm ? 'storm coming' : 'night falling' };
    }
    return {
      start: 'travel',
      args: { x: home!.x, z: home!.z, y: home!.y, arrivalRadius: 0.35, timeoutMs: 600000 },
      why: storm ? 'storm coming' : 'night falling',
    };
  },
  ended: (last, memory, reading) => {
    if (last.kind === 'shelter') shelter.ended?.(last, memory, reading);
  },
};
