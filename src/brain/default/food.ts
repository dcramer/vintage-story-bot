import type { Decision } from '../../runtime/brain.ts';
import { horizontal } from '../../runtime/navigation/terrain.ts';
import { supportedFloor, surfaceCover } from '../../support/sites.ts';
import type { Concern, Context } from './concern.ts';
import { failedOnItsOwn } from './concern.ts';
import { makeBag } from './tasks/bags.ts';
import { makeTool } from './tasks/tools.ts';

const ROOT = 'game:cattailroot';
const BATCH = 4;
const FORAGE_MS = 180000;
const COOK_MS = 600000;

// Food preparation belongs to the brain: each goal still has one outcome.
// Remember the owned firepit and food left in it across interrupted cooking.
export function food(ctx: Context, keep: number): Decision {
  const { k, memory, now, state, reading } = ctx;
  const count = (item: string) => k.slots.reduce((n, slot) => n + (slot.code === item ? slot.quantity : 0), 0);
  const roots = count(ROOT);
  if (k.reserve > 0 || ctx.tried.has(ctx.job) || (!roots && !memory.notes.cooking && now >= (memory.notes.cookUntil ?? 0)))
    return {
      start: 'forage',
      args: { until: 0.5, keep, timeoutMs: FORAGE_MS },
      why: `${k.reserve} carried; eat to half and look for edible forage before preparing roots`,
    };

  const pit = memory.notes.firepit;
  const pending = memory.notes.cooking;
  if (!pending) {
    if (!k.knife) return makeTool(k, 'knife', 'knifeblade', k.knifeBlade, 'game:knife-generic');
    if (k.emptyBagSlot && (k.bagItem || (k.free < 2 && (k.cattailtops > 0 || k.free > 0)))) return makeBag(ctx);
    if (!k.axe) return makeTool(k, 'axe', 'axehead', k.axeBlade, 'game:axe');
    if (!count('game:firestarter')) {
      if (k.sticks < 2)
        return {
          start: 'gather',
          args: { match: 'stick', item: 'game:stick', count: 2 - k.sticks, timeoutMs: 300000 },
          why: 'sticks for a firestarter',
        };
      if (!count('game:drygrass'))
        return {
          start: 'harvest',
          args: { match: 'tallgrass', item: 'drygrass', count: 1, tool: 'Knife', timeoutMs: 300000 },
          why: 'grass for a firestarter',
        };
      return { start: 'craft_item', args: { output: 'game:firestarter', count: 1, timeoutMs: 120000 }, why: 'a firestarter for cooking' };
    }
    const wood = (pit ? 8 : 12) - count('game:firewood');
    if (wood > 0) {
      if (!k.logs) return { start: 'fell_tree', args: { count: 3, timeoutMs: 300000 }, why: 'logs for cooking fuel' };
      return {
        start: 'craft_item',
        args: { output: 'game:firewood', count: Math.min(wood, k.logs * 4), timeoutMs: 120000 },
        why: 'firewood for cooking',
      };
    }
    if (!pit && !count('game:drygrass'))
      return {
        start: 'harvest',
        args: { match: 'tallgrass', item: 'drygrass', count: 1, tool: 'Knife', timeoutMs: 300000 },
        why: 'grass to build a firepit',
      };
    if (!roots)
      return {
        start: 'harvest',
        args: { match: 'coopersreed', item: ROOT, count: BATCH, tool: 'Knife', timeoutMs: 600000 },
        why: 'cattail roots when raw forage is scarce',
      };
  }

  if (!pit) {
    const p = state.position;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dz) !== 2) continue;
        const cell = { x: Math.floor(p.x) + dx, y: Math.floor(p.y), z: Math.floor(p.z) + dz };
        const block = reading.terrain?.get(cell.x, cell.y, cell.z);
        if (!block || block.hazard || (block.code !== 'game:air' && !surfaceCover(block))) continue;
        if (!supportedFloor(reading.terrain?.get(cell.x, cell.y - 1, cell.z), cell.y)) continue;
        if (surfaceCover(block))
          return { start: 'dig_area', args: { cells: [cell], timeoutMs: 60000 }, why: 'clear observed cover for the cooking firepit' };
        memory.notes.firepit = cell;
        return { start: 'firepit', args: cell, why: 'build an owned cooking firepit' };
      }
    return { start: 'explore', args: { legs: 1, manageFood: false, timeoutMs: 120000 }, why: 'find supported ground for a cooking firepit' };
  }
  if (horizontal(state.position, pit) > 3 || Math.abs(state.position.y - pit.y) > 1)
    return { start: 'travel', args: { ...pit, arrivalRadius: 2, manageFood: false, timeoutMs: 300000 }, why: 'return to the cooking firepit' };
  const block = reading.terrain?.get(pit.x, pit.y, pit.z);
  if (!/^game:firepit-(cold|extinct|lit)$/.test(block?.code ?? ''))
    return { start: 'firepit', args: pit, why: 'finish the owned firepit before cooking' };
  memory.notes.cooking ??= { count: Math.min(roots, BATCH) };
  return {
    start: 'cook',
    args: {
      target: `block:${state.position.dimension ?? 0}:${pit.x}:${pit.y}:${pit.z}:${block.code}`,
      item: ROOT,
      count: memory.notes.cooking.count,
      fuel: 8,
      timeoutMs: COOK_MS,
    },
    why: 'cook roots and retrieve any food left in the firepit',
  };
}

export const foodEnded: Concern['ended'] = (last, memory, reading) => {
  if (last.kind === 'forage' && !last.ok && last.outcome !== 'interrupted' && last.outcome !== 'refused')
    memory.notes.cookUntil = reading.now + COOK_MS;
  if (last.kind === 'firepit' && ['site_not_empty', 'unsupported_site'].includes(last.reason ?? last.result?.reason ?? '') && !memory.notes.cooking)
    memory.notes.firepit = null;
  if (last.kind === 'cook') {
    const remaining = (memory.notes.cooking?.count ?? 0) - (last.result?.moved ?? 0);
    if (last.ok || remaining <= 0) memory.notes.cooking = null;
    else memory.notes.cooking = { count: remaining };
  }
};

export const foodSetAside: Concern['setAside'] = last => last.kind !== 'forage' && failedOnItsOwn(last);
