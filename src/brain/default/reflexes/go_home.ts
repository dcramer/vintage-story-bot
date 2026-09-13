// Storm or night, away from home: walk home.

import { horizontal } from '../../../runtime/navigation/terrain.ts';
import { shelterCover } from '../../../support/sites.ts';
import { shelter as blueprint, SHELTER_MATERIAL, shelterDoor, shelterScaffold, shelterTorches } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { shelter } from '../tasks/shelter.ts';

export const goHome: Concern = {
  id: 'go_home',
  cuts: true,
  run: ctx => {
    const { home, storm, memory, k, state, reading } = ctx;
    const pending = memory.notes.shelter;
    if (
      !storm &&
      pending &&
      home &&
      horizontal(state.position, home) > 32 &&
      horizontal(state.position, { x: pending.x + 2.5, z: pending.z + 2.5 }) <= 8 &&
      Math.abs(state.position.y - pending.y) < 2
    ) {
      const cells = [shelterScaffold(pending, SHELTER_MATERIAL), ...blueprint(pending, SHELTER_MATERIAL), ...shelterDoor(pending, SHELTER_MATERIAL)];
      const observed = cells.map(c => reading.terrain?.get(c.x, c.y, c.z));
      const missing = observed.filter(block => block?.code !== SHELTER_MATERIAL).length;
      const supplies = item => k.slots.filter(s => s.code === item).reduce((n, s) => n + s.quantity, 0);
      const clear = observed.every(
        (block, i) =>
          block && (!block.code || block.code === 'game:air' || block.code === SHELTER_MATERIAL || shelterCover(block, cells[i].y - pending.y)),
      );
      const torch = k.torches > 0 || shelterTorches(pending).every(c => reading.terrain?.get(c.x, c.y, c.z)?.code?.startsWith('game:torch-basic-'));
      if (clear && missing <= 8 && supplies(SHELTER_MATERIAL) >= missing && torch && supplies('game:firestarter') > 0) return shelter.run(ctx);
    }
    const dwelling = memory.notes.dwelling;
    if (dwelling) {
      const have = k.slots.filter(s => s.code?.includes(dwelling.item)).reduce((n, s) => n + s.quantity, 0);
      if (have < 2 && dwelling.item === 'game:hay-normal-ud') {
        const grass = k.slots.filter(s => s.code === 'game:drygrass').reduce((n, s) => n + s.quantity, 0);
        if (grass < (2 - have) * 8)
          return {
            start: 'harvest',
            args: { match: 'tallgrass', item: 'drygrass', count: (2 - have) * 8 - grass, timeoutMs: 300000 },
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
