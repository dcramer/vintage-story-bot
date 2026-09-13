import { house, SHELTER_MATERIAL, shelter } from '../../../support/structures.ts';
import type { Concern, Notes } from '../concern.ts';

// The doorway is deliberately opened by entry/exit; those goals own its seal.
// Only observed empty shell cells are damage we can safely replace. Unknown
// terrain or a different occupied block is never permission to demolish it.
export function homeDamage(reading, notes: Notes) {
  const cells = notes.house ? house(notes.house, SHELTER_MATERIAL) : notes.starter ? shelter(notes.starter, SHELTER_MATERIAL) : [];
  return cells.filter(cell => {
    const block = reading.terrain?.get(cell.x, cell.y, cell.z);
    return block && !block.hazard && block.boxes.length === 0 && (!block.code || block.code === 'game:air');
  });
}

export const repairHome: Concern = {
  id: 'repair_home',
  title: 'the home shell repaired',
  done: s => !s.atHome || !s.homeDamaged,
  run: ctx => {
    const cells = homeDamage(ctx.reading, ctx.memory.notes);
    if (!cells.length) return { wait: 'no observed gaps in the home shell' };
    const count = (code: string) => ctx.k.slots.reduce((n, s) => n + (s.code === code ? s.quantity : 0), 0);
    const carried = count(SHELTER_MATERIAL);
    if (carried > 0)
      return {
        start: 'build',
        args: { cells: cells.slice(0, carried), timeoutMs: 600000 },
        why: 'replacing observed missing home walls or roof blocks',
      };
    const batch = Math.ceil(cells.length / 6) * 6;
    const packed = count('game:packeddirt');
    if (packed >= 6)
      return {
        start: 'craft_item',
        args: { output: SHELTER_MATERIAL, count: Math.min(batch, Math.floor(packed / 6) * 6), timeoutMs: 300000 },
        why: 'rammed earth to repair the home',
      };
    const soil = count('game:soil-low-none');
    if (soil >= 10)
      return {
        start: 'craft_item',
        args: { output: 'game:packeddirt', count: Math.min(batch, Math.floor((soil - 4) / 6) * 6), timeoutMs: 300000 },
        why: 'packing repair material while keeping the door reserve',
      };
    if (ctx.s.night || ctx.s.storm) return { wait: 'home damage needs materials; gathering waits for safe daylight' };
    return {
      start: 'harvest',
      args: { match: 'soil-low-', item: 'soil-low-none', count: batch + 4 - soil, tool: 'Shovel', timeoutMs: 600000 },
      why: 'soil to repair the observed home damage',
    };
  },
};
