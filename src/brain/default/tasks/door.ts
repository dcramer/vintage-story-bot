import { SHELTER_GATE, shelterDoorCells, shelterGate } from '../../../support/shelter-door.ts';
import type { Concern } from '../concern.ts';
import { goTo } from '../concern.ts';

export const door: Concern = {
  id: 'door',
  title: 'a durable operable door on the permanent house',
  done: s => !s.house || s.door === true,
  after: ['house', 'knife'],
  run: ctx => {
    const dwelling = ctx.memory.notes.dwelling;
    if (!ctx.memory.notes.house || !dwelling) return { wait: 'no permanent doorway to upgrade' };
    const cells = shelterDoorCells(dwelling.door);
    const observed = cells.map(cell => ctx.reading.terrain?.get(cell.x, cell.y, cell.z));
    if (observed.every(block => shelterGate(block?.code))) {
      ctx.memory.notes.dwelling = { ...dwelling, item: SHELTER_GATE, kind: 'gates' };
      return { wait: 'the permanent doorway already has two wattle gates' };
    }
    const outside = { x: dwelling.door.x + 0.5, y: dwelling.door.y, z: dwelling.door.z + 1.5 };
    const trip = goTo(ctx, outside, 'returning to the house doorway', 8, 2);
    if (trip) return trip;
    if (observed.some(block => !block))
      return { start: 'look_around', args: { radius: 8, limit: 16, timeoutMs: 60000 }, why: 'checking both permanent doorway cells' };
    const blocked = cells.filter((_cell, index) => {
      const block = observed[index];
      return !shelterGate(block?.code) && !!block?.code && block.code !== 'game:air';
    });
    if (blocked.length)
      return {
        start: 'dig_area',
        args: { cells: blocked, order: 'top-down', manageFood: false, sprint: false, timeoutMs: 600000 },
        why: 'removing the old block seal before installing the door',
      };
    const missing = cells.filter((_, index) => !shelterGate(observed[index]?.code));
    const carried = ctx.k.slots.filter(slot => slot.code === SHELTER_GATE).reduce((n, slot) => n + slot.quantity, 0);
    if (carried < missing.length) {
      const sticks = ctx.k.sticks;
      const need = (missing.length - carried) * 3;
      if (sticks < need)
        return {
          start: 'gather',
          args: { match: 'stick', item: 'game:stick', count: need - sticks, timeoutMs: 300000 },
          why: 'sticks for the permanent wattle door',
        };
      return {
        start: 'craft_item',
        args: { output: SHELTER_GATE, count: missing.length - carried, timeoutMs: 300000 },
        why: 'two durable wattle gates for the permanent doorway',
      };
    }
    return {
      start: 'build',
      args: { cells: missing.map(cell => ({ ...cell, item: SHELTER_GATE, placementAxis: 'n' as const })), timeoutMs: 600000 },
      why: 'installing the two-block operable door',
    };
  },
  ended: (last, memory) => {
    if (last.kind !== 'build' || !last.ok || !memory.notes.dwelling) return;
    memory.notes.dwelling = { ...memory.notes.dwelling, item: SHELTER_GATE, kind: 'gates' };
  },
};
