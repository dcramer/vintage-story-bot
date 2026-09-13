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
export const LOCAL_COOKING_DISTANCE = 48;

// Food preparation belongs to the brain: each goal still has one outcome.
// Remember the owned firepit and food left in it across interrupted cooking.
export function food(ctx: Context, keep: number): Decision {
  const { k, memory, now, state, reading } = ctx;
  const count = (item: string) => k.slots.reduce((n, slot) => n + (slot.code === item ? slot.quantity : 0), 0);
  const roots = count(ROOT);
  const batch = ctx.s.hunger !== null && ctx.s.hunger < 0.1 ? 1 : BATCH;
  if (k.reserve > 0 || ctx.tried.has(ctx.job) || (!roots && !memory.notes.cooking && now >= (memory.notes.cookUntil ?? 0)))
    return {
      start: 'forage',
      args: { until: 0.5, keep, timeoutMs: FORAGE_MS },
      why: `${k.reserve} carried; eat to half and look for edible forage before preparing roots`,
    };

  // While starving, an empty distant firepit is not worth a return trip.
  // Food already left cooking there still needs retrieval.
  if (batch === 1 && !memory.notes.cooking && memory.notes.firepit && horizontal(state.position, memory.notes.firepit) > LOCAL_COOKING_DISTANCE)
    memory.notes.firepit = null;
  const pit = memory.notes.firepit;
  const pending = memory.notes.cooking;
  const fuel = 2 * (pending?.count ?? Math.min(roots || batch, batch));
  if (!pending || pending.needsFuel) {
    if (!k.knife) return makeTool(k, 'knife', 'knifeblade', k.knifeBlade, 'game:knife-generic');
    if (k.emptyBagSlot && (k.bagItem || (k.free < 2 && (k.cattailtops > 0 || k.free > 0)))) {
      const bag = makeBag(ctx);
      // Equip or weave what is already carried, but one free slot is enough
      // for fuel preparation. Food must not wait for another reed expedition.
      if (k.free === 0 || bag.start !== 'harvest') return bag;
    }
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
    // A failed load can leave the firepit partially fueled. Carry enough for
    // the whole retry; the cook goal's fresh container read loads only the gap.
    const wood = fuel + (pit ? 0 : 4) - count('game:firewood');
    if (wood > 0) {
      if (!k.logs) return { start: 'fell_tree', args: { count: Math.ceil(wood / 4), timeoutMs: 300000 }, why: 'logs for cooking fuel' };
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
    if (!pending && !roots)
      return {
        start: 'harvest',
        args: { match: 'coopersreed', item: ROOT, count: batch, tool: 'Knife', timeoutMs: 600000 },
        why: 'cattail roots when raw forage is scarce',
      };
  }

  if (!pit) {
    const p = state.position;
    for (let dz = -2; dz <= 2; dz++)
      for (let dx = -2; dx <= 2; dx++) {
        if (Math.abs(dx) + Math.abs(dz) !== 2) continue;
        const cell = { x: Math.floor(p.x) + dx, y: Math.floor(p.y), z: Math.floor(p.z) + dz };
        if (memory.notes.failedFirepits?.some(f => f.until > now && f.x === cell.x && f.y === cell.y && f.z === cell.z)) continue;
        const block = reading.terrain?.get(cell.x, cell.y, cell.z);
        if (!block || block.hazard || (block.code && block.code !== 'game:air' && !surfaceCover(block))) continue;
        if (surfaceCover(block))
          return { start: 'dig_area', args: { cells: [cell], timeoutMs: 60000 }, why: 'clear observed cover for the cooking firepit' };
        if (!supportedFloor(reading.terrain?.get(cell.x, cell.y - 1, cell.z), cell.y)) continue;
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
  memory.notes.cooking ??= { count: Math.min(roots, batch) };
  return {
    start: 'cook',
    args: {
      target: `block:${state.position.dimension ?? 0}:${pit.x}:${pit.y}:${pit.z}:${block.code}`,
      item: ROOT,
      count: memory.notes.cooking.count,
      fuel,
      timeoutMs: COOK_MS,
    },
    why: 'cook roots and retrieve any food left in the firepit',
  };
}

export const foodEnded: Concern['ended'] = (last, memory, reading) => {
  if (last.kind === 'forage' && !last.ok && last.outcome !== 'interrupted' && last.outcome !== 'refused')
    memory.notes.cookUntil = reading.now + COOK_MS;
  // A remembered firepit is only useful while the bot can still reach it. If
  // that walk fails, abandon both the site and any assumed contents so the
  // next food decision prepares a complete local cooking attempt instead of
  // walking back to the same unreachable ledge forever.
  if (last.kind === 'travel' && !last.ok && failedOnItsOwn(last)) {
    memory.notes.firepit = null;
    memory.notes.cooking = null;
  }
  if (
    last.kind === 'firepit' &&
    ['site_not_empty', 'unsupported_site', 'support_not_selectable', 'no_observed_effect'].includes(last.reason ?? last.result?.reason ?? '') &&
    !memory.notes.cooking
  ) {
    const cell = last.result?.cell ?? memory.notes.firepit;
    if (cell)
      memory.notes.failedFirepits = [
        ...(memory.notes.failedFirepits ?? []).filter(p => p.until > reading.now && (p.x !== cell.x || p.y !== cell.y || p.z !== cell.z)),
        { x: cell.x, y: cell.y, z: cell.z, until: reading.now + 1200000 },
      ].slice(-16);
    memory.notes.firepit = null;
  }
  if (last.kind === 'cook') {
    if (last.ok && (last.result?.moved ?? 0) > 0) memory.notes.cookUntil = reading.now + COOK_MS;
    const remaining = (memory.notes.cooking?.count ?? 0) - (last.result?.moved ?? 0);
    if (last.ok || remaining <= 0) memory.notes.cooking = null;
    else {
      const reason = last.reason ?? last.result?.reason;
      const needsFuel =
        memory.notes.cooking?.needsFuel === true ||
        (last.result?.phase === 'loading' && last.result?.slot === 0 && ['none_found', 'transfer_unverified'].includes(reason ?? ''));
      memory.notes.cooking = { count: remaining, ...(needsFuel ? { needsFuel: true } : {}) };
    }
  }
};

export const foodSetAside: Concern['setAside'] = last => {
  const reason = last.reason ?? last.result?.reason;
  const recoverableFuelLoad =
    last.kind === 'cook' &&
    last.result?.phase === 'loading' &&
    last.result?.slot === 0 &&
    ['none_found', 'transfer_unverified'].includes(reason ?? '');
  return !['forage', 'travel', 'firepit'].includes(last.kind) && !recoverableFuelLoad && failedOnItsOwn(last);
};
