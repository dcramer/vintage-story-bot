import { shelterTorches } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { goHome } from '../reflexes/go_home.ts';
import { torches } from './torches.ts';

export function prepareFirestarter(ctx) {
  const count = (item: string) => ctx.k.slots.reduce((n, s) => n + (s.code === item ? s.quantity : 0), 0);
  if (!count('game:firestarter')) {
    if (ctx.k.sticks < 2)
      return {
        start: 'gather',
        args: { match: 'stick', item: 'game:stick', count: 2 - ctx.k.sticks, timeoutMs: 300000 },
        why: 'sticks for a firestarter',
      };
    if (!count('game:drygrass'))
      return { start: 'harvest', args: { match: 'tallgrass', item: 'drygrass', count: 1, timeoutMs: 300000 }, why: 'dry grass for a firestarter' };
    return { start: 'craft_item', args: { output: 'game:firestarter', count: 1, timeoutMs: 300000 }, why: 'a firestarter to light the shelter' };
  }
  return null;
}

export const lightingDay = environment => Math.floor((environment?.calendar?.totalDays ?? 0) - 5 / 24);
export const torchCells = notes =>
  notes.house
    ? [1, 8].map(dx => ({ x: notes.house.x + dx, y: notes.house.y - 1, z: notes.house.z + 3 }))
    : notes.starter
      ? shelterTorches(notes.starter)
      : notes.home
        ? [{ x: Math.floor(notes.home.x), y: Math.floor(notes.home.y), z: Math.floor(notes.home.z) }]
        : [];

export function shelterLight(reading, notes) {
  const cells = torchCells(notes);
  const installed = cells.filter(cell => {
    const block = reading.terrain?.get(cell.x, cell.y, cell.z);
    return block ? block.code?.startsWith('game:torch-basic-') : Number.isFinite(notes.lightingDay);
  }).length;
  const lit =
    cells.length > 0 &&
    notes.lightingDay === lightingDay(reading.environment) &&
    cells.every(cell => {
      const block = reading.terrain?.get(cell.x, cell.y, cell.z);
      return !block || block.code?.startsWith('game:torch-basic-lit-');
    });
  return { installed, lit };
}

export const lighting: Concern = {
  id: 'lighting',
  cuts: ({ s, active }) => s.atHome && !s.lit && active?.kind !== 'craft_item',
  title: 'lit shelter torches, refreshed daily',
  done: s => s.lit === true,
  after: ['shelter'],
  run: ctx => {
    const missing = torchCells(ctx.memory.notes).length - shelterLight(ctx.reading, ctx.memory.notes).installed;
    if (ctx.k.torches < missing) return torches.run(ctx);
    const prepare = prepareFirestarter(ctx);
    if (prepare) return prepare;
    if (!ctx.s.atHome) return goHome.run(ctx);
    const cells = torchCells(ctx.memory.notes);
    return { start: 'light_shelter', args: { cells, refresh: true }, why: 'freshly placed, lit torches for the shelter' };
  },
  ended: (last, memory, reading) => {
    if (last.ok && last.kind === 'light_shelter') memory.notes.lightingDay = lightingDay(reading.environment);
  },
};
