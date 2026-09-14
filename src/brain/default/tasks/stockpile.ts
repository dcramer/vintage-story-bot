import { horizontal } from '../../../runtime/navigation/terrain.ts';
import type { Concern, Stash } from '../concern.ts';
import { allStashes, goTo, noteContents, selectStash } from '../concern.ts';
import type { Kit } from '../situation.ts';

// Five stack types leave room in a reed chest for a spare knife and finds.
export const SUPPLIES = [
  { item: 'game:stick', count: 32, keep: 4, goal: 'gather', match: 'stick' },
  { item: 'game:flint', count: 16, keep: 2, goal: 'gather', match: 'looseflints' },
  { item: 'log-', count: 16, keep: 8, goal: 'fell_tree', match: 'log-' },
  { item: 'drygrass', count: 32, keep: 4, goal: 'harvest', match: 'tallgrass', tool: 'Knife' },
  { item: 'cattailtops', count: 24, keep: 0, goal: 'harvest', match: 'coopersreed', tool: 'Knife' },
] as const;
export const STOCK_CHECK_MS = 5 * 60 * 1000;
const held = (items: Record<string, number>, item: string) => Object.entries(items).reduce((n, [code, q]) => n + (code.includes(item) ? q : 0), 0);
export const suppliesMissing = (stashes: Stash | Stash[] | null) => {
  const stores = Array.isArray(stashes) ? stashes : stashes ? [stashes] : [];
  return SUPPLIES.filter(s => stores.reduce((n, stash) => n + held(stash.seen?.items ?? {}, s.item), 0) < s.count);
};
const carried = (k: Kit, item: string) => k.slots.reduce((n, s) => n + (s.code?.includes(item) ? s.quantity : 0), 0);

export const stockpile: Concern = {
  id: 'stockpile',
  title: 'shared sticks, flint, logs, grass and cattails',
  done: s => s.stocked === true,
  after: ['storage', 'shelter', 'knife', 'axe'],
  run: ctx => {
    const stores = allStashes(ctx.memory.notes);
    const stale = stores
      .filter(s => !s.seen || ctx.now - s.seen.at >= STOCK_CHECK_MS)
      .sort((a, b) => horizontal(a, ctx.state.position) - horizontal(b, ctx.state.position));
    let stash = stale[0] ?? ctx.memory.notes.stash!;
    if (stash !== ctx.memory.notes.stash) selectStash(ctx.memory, stash);
    // Home storage sits against an interior wall. A loose proximity check can
    // stop outside that wall, where the container is close but occluded. Enter
    // the owned dwelling first so the following inspect/store has native line
    // of sight to the basket.
    if (ctx.home && !ctx.s.atHome && horizontal(stash, ctx.home) <= 8) return { handoff: 'go_home' };
    const approach = (why: string) => (ctx.home && ctx.s.atHome && horizontal(stash, ctx.home) <= 8 ? null : goTo(ctx, stash, why, 3));
    if (!stash.seen || ctx.now - stash.seen.at >= STOCK_CHECK_MS) {
      return (
        approach('checking shared supplies') ?? {
          start: 'inspect_container',
          args: { target: stash.key },
          why: 'check what teammates have used',
        }
      );
    }
    const supply = suppliesMissing(stores)[0];
    if (!supply) return { wait: 'shared supplies stocked' };
    const need = supply.count - stores.reduce((n, s) => n + held(s.seen?.items ?? {}, supply.item), 0);
    if (stash.full) {
      const available = stores.find(s => !s.full);
      if (available) {
        stash = available;
        selectStash(ctx.memory, stash);
      }
    }
    const spare = Math.max(0, carried(ctx.k, supply.item) - supply.keep);
    if (spare > 0)
      return (
        approach('putting shared supplies away') ?? {
          start: 'store_items',
          args: { target: stash.key, items: [{ item: supply.item, count: Math.min(need, spare) }], timeoutMs: 600000 },
          why: `stocking ${supply.item} for teammates`,
        }
      );
    return {
      start: supply.goal,
      args: {
        count: Math.min(32, need + supply.keep - carried(ctx.k, supply.item)),
        timeoutMs: 900000,
        ...(supply.goal === 'fell_tree' ? {} : { match: supply.match, item: supply.item }),
        ...('tool' in supply ? { tool: supply.tool } : {}),
      },
      why: `${need} ${supply.item} still needed in shared storage`,
    };
  },
  ended: (last, memory, { now }) => noteContents(memory, last, now),
};
