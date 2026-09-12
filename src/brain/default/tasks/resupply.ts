// What the basket was last seen holding that the kit is short of is fetched
// before it is gathered again: sticks, flint, dirt, grass, torches, logs.
import type { Concern, Stash } from '../concern.ts';
import { goTo, noteContents } from '../concern.ts';
import type { Kit } from '../situation.ts';
import { dirt } from './dirt.ts';
import { grass } from './grass.ts';
import { logs } from './logs.ts';
import { sticks } from './sticks.ts';
import { stone } from './stone.ts';
import { torches } from './torches.ts';

const FEEDS: Concern[] = [sticks, stone, dirt, grass, torches, logs];

// The shortfalls the basket can fill, by what it was last seen holding.
export function resupplyOf(k: Kit, s: { home: boolean; torches: number }, stash: Stash | null): { item: string; count: number }[] {
  if (!stash?.seen) return [];
  const held = (item: string) =>
    Object.entries(stash.seen!.items)
      .filter(([code]) => code.includes(item))
      .reduce((n, [, q]) => n + q, 0);
  return FEEDS.map(task => task.short?.(k, s))
    .filter((want): want is { item: string; count: number } => !!want && want.count > 0)
    .map(want => ({ item: want.item, count: Math.min(want.count, held(want.item)) }))
    .filter(want => want.count > 0);
}

export const resupply: Concern = {
  id: 'resupply',
  title: 'what the basket holds that I am short of',
  done: s => s.short === 0,
  run: ctx => {
    const note = ctx.memory.notes.stash as Stash;
    const items = resupplyOf(ctx.k, { home: !!ctx.home, torches: ctx.k.torches }, note);
    return (
      goTo(ctx, note, 'going home for what the basket holds') ?? {
        start: 'take_items',
        args: { target: note.key, items, manageFood: true, timeoutMs: 600000 },
        why: `the basket holds ${items.map(i => `${i.count} ${i.item.replace(/^game:/, '')}`).join(', ')}`,
      }
    );
  },
  ended: (last, memory, { now }) => noteContents(memory, last, now),
};
