import { shelterTorches } from '../../../support/structures.ts';
import type { Concern } from '../concern.ts';
import { torchStep } from './torches.ts';

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
      return {
        start: 'harvest',
        args: { match: 'tallgrass', item: 'drygrass', count: 1, tool: 'Knife', timeoutMs: 300000 },
        why: 'dry grass for a firestarter',
      };
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
  // This concern owns one fixed shelter. Walking beyond the generic local
  // failure radius must not reactivate it and drag an unrelated trip home.
  setAsideEverywhere: true,
  cuts: ({ s, active }) => s.atHome && !s.lit && active?.kind !== 'craft_item',
  title: 'lit shelter torches, refreshed daily',
  // There is nothing to light while a replacement permanent home is only a
  // construction plan. This also keeps goHome from dereferencing a home note
  // that was deliberately discarded with a seasonal shelter.
  done: s => !s.home || s.lit === true,
  after: ['shelter'],
  running: ({ active, s, hurt, classifyingHurt }) =>
    s.sheltered && !hurt && !classifyingHurt && ['light_shelter', 'craft_item'].includes(active?.kind ?? '')
      ? { wait: 'finishing lighting inside the sealed shelter' }
      : null,
  run: ctx => {
    const cells = torchCells(ctx.memory.notes);
    // Cells needing a fresh torch from the pack: observed empty, obstructed or
    // burnt out. Burnt-out torches drop nothing and cannot be relit;
    // extinguished ones relight where they stand. Unknown cells count until
    // the first lighting, then read as fine until observed otherwise.
    const needSpare = cells.filter(cell => {
      const block = ctx.reading.terrain?.get(cell.x, cell.y, cell.z);
      if (!block) return !Number.isFinite(ctx.memory.notes.lightingDay);
      const code = block.code ?? '';
      return !code.includes('torch-basic-') || code.includes('torch-basic-burnedout-');
    }).length;
    if (ctx.k.torches < needSpare) {
      const step = torchStep(ctx.k, ctx.s);
      if (ctx.s.sheltered && (ctx.danger || ctx.s.night) && (!('start' in step) || step.start !== 'craft_item'))
        return { wait: 'lighting needs materials outside; remain sealed until safe to leave' };
      return step;
    }
    const prepare = prepareFirestarter(ctx);
    if (prepare) {
      if (ctx.s.sheltered && (ctx.danger || ctx.s.night) && (!('start' in prepare) || prepare.start !== 'craft_item'))
        return { wait: 'lighting needs materials outside; remain sealed until safe to leave' };
      return prepare;
    }
    if (!ctx.s.atHome) return { handoff: 'go_home' };
    // The day's refresh replaces torches; after a failed refresh, relight what
    // stands instead of digging it all up again.
    const refresh = ctx.memory.notes.lightingDay !== lightingDay(ctx.reading.environment) && !ctx.memory.lightingFailed;
    return {
      start: 'light_shelter',
      args: { cells, refresh },
      why: refresh ? 'freshly placed, lit torches for the shelter' : 'relighting torches that went out',
    };
  },
  ended: (last, memory, reading) => {
    memory.lightingFailed = last.kind === 'light_shelter' && !last.ok;
    if (last.ok && last.kind === 'light_shelter') memory.notes.lightingDay = lightingDay(reading.environment);
  },
};
