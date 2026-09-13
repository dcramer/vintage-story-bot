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
const LOCAL_COOKING_HEIGHT = 2;

// Failed routes defer food, never prove that it disappeared. Resume only
// once back beside the observed firepit, after a short retry cooldown.
export const nearbyCooking = ({ memory, state, reading, now }: Context) =>
  !memory.notes.cooking &&
  memory.notes.deferredCooking?.find(
    p =>
      p.retryAfter <= now &&
      horizontal(state.position, p) <= 3 &&
      Math.abs(state.position.y - p.y) <= LOCAL_COOKING_HEIGHT &&
      /^game:firepit-(cold|extinct|lit)$/.test(reading.terrain?.get(p.x, p.y, p.z)?.code ?? ''),
  );

// Food preparation belongs to the brain: each goal still has one outcome.
// Remember the owned firepit and food left in it across interrupted cooking.
export function food(ctx: Context, keep: number): Decision {
  const { k, memory, now, state, reading } = ctx;
  const count = (item: string) => k.slots.reduce((n, slot) => n + (slot.code === item ? slot.quantity : 0), 0);
  const roots = count(ROOT);
  const deferred = nearbyCooking(ctx);
  if (deferred) {
    const { x, y, z, count: pendingCount, needsFuel } = deferred;
    memory.notes.firepit = { x, y, z };
    memory.notes.cooking = { count: pendingCount, ...(needsFuel ? { needsFuel: true } : {}) };
    memory.notes.deferredCooking = memory.notes.deferredCooking.filter(p => p !== deferred);
    delete memory.tried[ctx.job];
    ctx.tried.delete(ctx.job);
    const code = reading.terrain.get(x, y, z).code;
    return {
      start: 'take_items',
      args: {
        target: `block:${state.position.dimension ?? 0}:${x}:${y}:${z}:${code}`,
        items: [{ item: 'game:vegetable-cookedcattailroot', count: pendingCount }],
        timeoutMs: 30000,
      },
      why: 'check food left in the nearby owned firepit before preparing more fuel',
    };
  }

  const emergency = ctx.s.hunger !== null && ctx.s.hunger < 0.1;
  const batch = emergency ? 1 : BATCH;
  // Only starvation justifies uprooting new cattails. A failed forage may
  // still fall back to carried roots despite a partial food reserve.
  if (
    ctx.tried.has(ctx.job) ||
    (now >= (memory.notes.cookUntil ?? 0) && k.reserve > 0) ||
    (!roots && !memory.notes.cooking && (!emergency || now >= (memory.notes.cookUntil ?? 0)))
  )
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
      // Equip or weave carried supplies. Even a full pack must not send food
      // recovery on a second reed expedition for an additional basket.
      if (bag.start !== 'harvest') return bag;
    }
    // Loading a carried root frees its slot for the cooked result. Before
    // gathering a new root, make room from expendable soil, retaining a seal.
    if (emergency && !roots && k.free === 0) {
      const soil = k.slots
        .filter(s => /^game:soil-(low|verylow)-/.test(s.code ?? '') && k.dirt - s.quantity >= 4)
        .sort((a, b) => a.quantity - b.quantity)[0];
      if (soil)
        return {
          act: [{ action: 'drop', from: { inventory: soil.inventory, slot: soil.slot }, quantity: soil.quantity, expectedState: k.state }],
          why: 'make room for emergency food while retaining shelter sealing blocks',
        };
    }
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
      if (!k.axe) return makeTool(k, 'axe', 'axehead', k.axeBlade, 'game:axe');
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
        why: 'one emergency cattail root after raw forage failed below 10% satiety',
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
  if (horizontal(state.position, pit) > 3 || Math.abs(state.position.y - pit.y) > LOCAL_COOKING_HEIGHT)
    return { start: 'travel', args: { ...pit, arrivalRadius: 2, manageFood: false, timeoutMs: 300000 }, why: 'return to the cooking firepit' };
  const observedCode = reading.terrain?.get(pit.x, pit.y, pit.z)?.code;
  // The verified placement result can arrive before its terrain delta has
  // reached the next brain reading. Carry that result straight into cooking;
  // otherwise the consumed grass makes a second firepit attempt fail and the
  // same stale reading can churn that failure indefinitely.
  const built = reading.last?.kind === 'firepit' && reading.last.ok ? reading.last.result : null;
  const builtHere = built?.cell?.x === pit.x && built?.cell?.y === pit.y && built?.cell?.z === pit.z;
  const code = /^game:firepit-(cold|extinct|lit)$/.test(observedCode ?? '')
    ? observedCode
    : builtHere && /^game:firepit-(cold|extinct|lit)$/.test(built?.code ?? '')
      ? built.code
      : null;
  if (!code) return { start: 'firepit', args: pit, why: 'finish the owned firepit before cooking' };
  memory.notes.cooking ??= { count: Math.min(roots, batch) };
  return {
    start: 'cook',
    args: {
      target: `block:${state.position.dimension ?? 0}:${pit.x}:${pit.y}:${pit.z}:${code}`,
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
  // Keep ownership and pending food when a route fails, without retrying
  // that unreachable destination instead of preparing food locally.
  if (last.kind === 'travel' && !last.ok && failedOnItsOwn(last)) {
    const pit = memory.notes.firepit;
    if (pit && memory.notes.cooking) {
      memory.notes.deferredCooking = [
        ...(memory.notes.deferredCooking ?? []).filter(p => p.x !== pit.x || p.y !== pit.y || p.z !== pit.z),
        { ...pit, ...memory.notes.cooking, retryAfter: reading.now + 60000 },
      ].slice(-16);
    }
    memory.notes.firepit = null;
    memory.notes.cooking = null;
  }
  if (
    last.kind === 'take_items' &&
    memory.notes.firepit &&
    last.result?.target?.includes(`:${memory.notes.firepit.x}:${memory.notes.firepit.y}:${memory.notes.firepit.z}:game:firepit-`) &&
    memory.notes.cooking
  ) {
    const moved = (last.result.items ?? []).filter(i => i.item === 'game:vegetable-cookedcattailroot').reduce((n, i) => n + (i.moved ?? 0), 0);
    if (moved > 0) {
      memory.notes.cooking.count -= moved;
      if (memory.notes.cooking.count <= 0) memory.notes.cooking = null;
    }
    if (Array.isArray(last.result.contents) && !last.result.contents.some(s => s.code === ROOT || s.code === 'game:vegetable-cookedcattailroot'))
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

export const foodSetAside: Concern['setAside'] = (last, memory, reading) => {
  const reason = last.reason ?? last.result?.reason;
  // An optional provisions pass that exhausted the local forage must yield to
  // the work list instead of immediately starting the identical bounded search
  // again. Urgent recovery keeps searching, and carried roots still enter the
  // cooking fallback below.
  if (last.kind === 'forage') {
    const roots = reading.inventory?.inventories
      ?.flatMap(inventory => inventory.slots ?? [])
      .reduce((n, slot) => n + (slot.code === ROOT ? (slot.quantity ?? 0) : 0), 0);
    return memory.job === 'provisions' && !roots && !memory.notes.cooking && failedOnItsOwn(last);
  }
  // A bounded root search may exhaust the area after collecting part of its
  // batch. Those roots are already a useful result; cook them instead of
  // setting aside the whole food concern and starting raw forage again.
  if (last.kind === 'harvest' && last.result?.item === ROOT && (last.result?.gained ?? 0) > 0) return false;
  if (last.kind === 'take_items' && last.result?.target?.includes(':game:firepit-') && last.result?.reason === 'none_found') return false;
  const recoverableFuelLoad =
    last.kind === 'cook' &&
    last.result?.phase === 'loading' &&
    last.result?.slot === 0 &&
    ['none_found', 'transfer_unverified'].includes(reason ?? '');
  return !['travel', 'firepit'].includes(last.kind) && !recoverableFuelLoad && failedOnItsOwn(last);
};
