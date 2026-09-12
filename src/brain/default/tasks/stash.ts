// The surplus put away when the pack is full: whatever the kit does not need on hand
// goes into the basket at home, most of it first. Tools, torches and food stay; so do
// the sticks, logs, dirt and grass the day-1 list keeps. Recurring: done until the
// pack fills again.
import type { Concern, Stash } from '../concern.ts';
import { goTo, noteContents } from '../concern.ts';
import type { Kit } from '../situation.ts';
import { LOG_MIN } from './logs.ts';
import { SHELTER_DIRT } from './shelter.ts';
import { STICK_MIN } from './sticks.ts';
import { TORCH_MIN } from './torches.ts';

// A pack with this many ordinary slots free or fewer is full.
export const FULL_SLOTS = 1;

// What to put away, by code with a count, most first; at most what one goal takes.
export function surplusOf(k: Kit, { home, torches }: { home: boolean; torches: number }): { item: string; count: number }[] {
  const keep = (code: string) => {
    if (code === 'game:stick') return STICK_MIN;
    if (code.includes('log-')) return LOG_MIN;
    if (code.includes('soil-')) return home ? 0 : SHELTER_DIRT;
    if (code.includes('drygrass') || code.includes('cattailtops')) return torches < TORCH_MIN ? Infinity : 0;
    if (code === 'game:flint' || /^game:stone-/.test(code)) return k.knife && k.axe && k.shovel ? 0 : Infinity;
    return 0;
  };
  const totals = new Map<string, number>();
  // One tool of each class stays, the one with the most edge left; a second is a spare for the basket.
  const kept = new Set<any>();
  for (const cls of new Set(k.slots.filter(s => s.tool).map(s => s.tool)))
    kept.add(k.slots.filter(s => s.tool === cls).sort((a, b) => (b.durability ?? 0) - (a.durability ?? 0))[0]);
  for (const slot of k.slots) {
    if (!slot.code || !(slot.quantity > 0) || slot.bag || kept.has(slot) || slot.nutrition || slot.code.includes('torch-basic')) continue;
    totals.set(slot.code, (totals.get(slot.code) ?? 0) + slot.quantity);
  }
  return [...totals]
    .map(([item, total]) => ({ item, count: total - keep(item) }))
    .filter(entry => entry.count > 0)
    .sort((a, b) => b.count - a.count)
    .slice(0, 16);
}

export const stash: Concern = {
  id: 'stash',
  title: 'the surplus put away',
  done: s => !s.storage || !s.full || s.surplus === 0,
  after: ['storage'],
  run: ctx => {
    const note = ctx.memory.notes.stash as Stash;
    const items = surplusOf(ctx.k, { home: !!ctx.home, torches: ctx.k.torches });
    return (
      goTo(ctx, note, 'pack full, going home to put things away') ?? {
        start: 'store_items',
        args: { target: note.key, items, manageFood: true, timeoutMs: 600000 },
        why: `pack full, ${items.reduce((n, i) => n + i.count, 0)} things to put away`,
      }
    );
  },
  ended: (last, memory, { now }) => noteContents(memory, last, now),
};
