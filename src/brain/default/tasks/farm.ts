import { horizontal } from '../../../runtime/navigation/terrain.ts';
import {
  type Farm,
  farmApproach,
  farmBeds,
  farmCell,
  farmFence,
  farmGate,
  farmGroundwork,
  farmMargin,
  farmSite,
  farmSurveyClearing,
  farmSurveyGroundwork,
  farmSurveySite,
  fertileBed,
} from '../../../support/farming.ts';
import { hostileEntity, threatClearDistance, threatClearRadius, threatVerticalRange } from '../../../support/threats.ts';
import type { Concern } from '../concern.ts';
import { allStashes, failedOnItsOwn, goTo, noteContents, selectStash } from '../concern.ts';

export type FarmNote = Farm & {
  soil: string;
  wood: string;
  rotation: number;
  prepared: boolean;
  checkedAt: number;
  surveyed?: boolean;
  siteFailures?: number;
};
export const FARM_CHECK_MS = 5 * 60 * 1000;
export const FARM_SITE_FAILURES = 3;
export const FARM_SITE_RETRY_MS = 15 * 60 * 1000;
// Moving the origin just past the old footprint still leaves the whole new
// enclosure inside the same predator perimeter. Include half the farm margin
// beyond the ordinary clear radius so a replacement is actually elsewhere.
export const FARM_SITE_REJECT_RADIUS = threatClearRadius + 4;
const woods = new Set(['birch', 'oak', 'maple', 'pine', 'acacia', 'kapok', 'aged', 'baldcypress', 'larch', 'redwood', 'walnut']);
const GUARDED_SITE = 'farm site is inside a hostile perimeter';

const guarded = (ctx: Parameters<Concern['run']>[0], plan: Farm) =>
  (ctx.state.nearbyEntities ?? []).some(entity => {
    if (!entity.code || !entity.point || !hostileEntity(entity)) return false;
    return farmMargin(plan).some(
      cell =>
        Math.abs(cell.y - entity.point.y) <= threatVerticalRange(entity.code) && horizontal(cell, entity.point) <= threatClearDistance(entity.code),
    );
  });

const rejectSite = (memory: Parameters<NonNullable<Concern['setAside']>>[1], plan: Farm, now: number) => {
  const failures = (memory.notes.failedFarms ?? []).filter(
    failed => failed.until > now && horizontal(failed.origin, plan.origin) >= FARM_SITE_REJECT_RADIUS,
  );
  failures.push({ origin: { ...plan.origin }, turn: plan.turn, until: now + FARM_SITE_RETRY_MS });
  memory.notes.failedFarms = failures.slice(-8);
};

export function farmDue(reading, plan: FarmNote | null | undefined) {
  if (!plan?.prepared || reading.now - plan.checkedAt >= FARM_CHECK_MS) return true;
  return [...farmFence(plan), farmGate(plan)].some(p => {
    const b = reading.terrain?.get(p.x, p.y, p.z);
    return b && (!b.code || b.code === 'game:air');
  });
}

export const farm: Concern = {
  id: 'farm',
  title: 'an irrigated, fenced farm tended and rotated',
  done: s => s.farmTended === true,
  after: ['storage', 'shelter', 'hoe', 'shovel', 'axe'],
  running: ctx => {
    const plan = ctx.memory.notes.farm;
    if (plan && ['build', 'dig_area', 'farm'].includes(ctx.active?.kind ?? '') && guarded(ctx, plan)) return { stop: GUARDED_SITE };
    return null;
  },
  run: ctx => {
    const { k, memory, reading } = ctx;
    const now = Number.isFinite(ctx.now) ? ctx.now : Number.isFinite(reading.now) ? reading.now : Date.now();
    const failedFarms = (memory.notes.failedFarms ?? []).filter(failed => failed.until > now);
    if (failedFarms.length) memory.notes.failedFarms = failedFarms;
    else delete memory.notes.failedFarms;
    let plan = memory.notes.farm;
    if (!plan) {
      const center = ctx.home ?? ctx.state.position;
      const safe = (candidate: Farm) =>
        !guarded(ctx, candidate) && !failedFarms.some(failed => horizontal(failed.origin, candidate.origin) < FARM_SITE_REJECT_RADIUS);
      const ready = farmSite(reading.terrain, center, 64, safe);
      const site = ready ?? farmSurveySite(reading.terrain, center, 64, safe);
      if (!site)
        return (
          goTo(ctx, { x: center.x, z: center.z }, 'returning to the farm search area', 48, 8) ?? {
            start: 'explore',
            args: { legs: 1, timeoutMs: 180000 },
            why: 'looking for freshwater beside ground that can be graded for a farm',
          }
        );
      const carriedWood = k.slots.map(s => s.code?.match(/^game:log-(?:grown|placed)-([a-z]+)-/)?.[1]).find(w => woods.has(w));
      if (!carriedWood)
        return {
          start: 'fell_tree',
          args: { count: 8, timeoutMs: 600000 },
          why: 'choose the farm enclosure wood from locally gathered logs',
        };
      plan = memory.notes.farm = {
        ...site,
        soil: 'game:soil-medium-none',
        wood: carriedWood,
        rotation: 0,
        prepared: false,
        checkedAt: 0,
        ...(ready ? {} : { surveyed: false }),
      };
    }
    const count = code => k.slots.filter(s => s.code?.includes(code)).reduce((n, s) => n + s.quantity, 0);
    const ground = p => reading.terrain?.get(p.x, p.y, p.z)?.code ?? '';
    if (!plan.prepared) {
      const groundwork = farmGroundwork(reading.terrain, plan);
      if (!groundwork) {
        // A just-placed or dug block is invalidated before the eye reports its
        // replacement. Preserve the established site through that transient
        // unknown and look at it again; known bad terrain still falls through
        // to normal rejection below.
        const unobserved = [];
        for (let x = 0; x < 6; x++) for (let z = 0; z < 4; z++) unobserved.push(farmCell(plan, x, z, -1));
        for (const p of farmMargin(plan)) for (let h = 0; h < 2; h++) unobserved.push({ ...p, y: p.y + h });
        if (unobserved.some(p => !reading.terrain?.get(p.x, p.y, p.z))) {
          const center = farmCell(plan, 2, 2);
          const trip = goTo(ctx, { x: center.x + 0.5, y: plan.origin.y, z: center.z + 0.5 }, 'rechecking the changed farm footprint', 8, 6);
          return (
            trip ?? {
              start: 'look_around',
              args: { radius: 16, limit: 16, timeoutMs: 60000 },
              why: 'confirming recently changed farm cells before revalidation',
            }
          );
        }
        if (farmSurveyGroundwork(reading.terrain, plan)) {
          const center = farmCell(plan, 2, 2);
          const trip = goTo(ctx, { x: center.x + 0.5, y: plan.origin.y, z: center.z + 0.5 }, 'surveying the farm footprint', 8, 6);
          if (trip) return trip;
          if (!plan.surveyed)
            return {
              start: 'look_around',
              args: { radius: 16, limit: 16, timeoutMs: 60000 },
              why: 'checking the whole farm margin before clearing it',
            };
          const clearing = farmSurveyClearing(reading.terrain, plan);
          if (clearing.length)
            return {
              start: 'dig_area',
              args: { cells: clearing.slice(0, 12), order: 'given', timeoutMs: 600000 },
              why: 'removing vegetation and raised natural ground from the surveyed farm site',
            };
        }
        rejectSite(memory, plan, now);
        memory.notes.farm = null;
        return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'refreshing terrain for a farm site that can be graded' };
      }
      delete plan.surveyed;
      // Build the dry platform before clearing the enclosure beyond it. On a
      // shoreline, those distant cells may only be reachable by swimming until
      // the planned fill exists; block work correctly refuses wet footing.
      // A solid block occupying a fill cell still has to be removed first.
      const fillKeys = new Set(groundwork.fill.map(cell => `${cell.x}:${cell.y}:${cell.z}`));
      const clearing = groundwork.fill.length ? groundwork.clear.filter(cell => fillKeys.has(`${cell.x}:${cell.y}:${cell.z}`)) : groundwork.clear;
      if (clearing.length) {
        const returnTrip = goTo(ctx, farmApproach(plan), 'returning to the farm site before grading', 12, 6);
        return (
          returnTrip ?? {
            start: 'dig_area',
            args: { cells: clearing.slice(0, 12), order: 'given', timeoutMs: 600000 },
            why: 'clearing vegetation and one-block rises from the farm site',
          }
        );
      }
      if (groundwork.fill.length) {
        const foundations = ['game:soil-low-none', 'game:soil-verylow-none']
          .map(item => ({ item, count: count(item) }))
          .sort((a, b) => b.count - a.count);
        const foundation = foundations[0];
        const batch = Math.min(8, groundwork.fill.length);
        if (foundation.count < batch) {
          const grade = foundation.item.includes('verylow') ? 'verylow' : 'low';
          const forestFloor =
            grade === 'low' &&
            [...(reading.terrain?.cells?.values() ?? [])].some(
              (cell: any) =>
                cell.code?.startsWith('game:forestfloor-') && Math.hypot(cell.x + 0.5 - plan.origin.x, cell.z + 0.5 - plan.origin.z) <= 64,
            );
          return {
            start: 'harvest',
            args: {
              match: forestFloor ? 'forestfloor-' : `soil-${grade}-`,
              item: foundation.item,
              count: batch - foundation.count,
              tool: 'Shovel',
              timeoutMs: 600000,
            },
            why: 'ordinary earth to grade the farm platform',
          };
        }
        const returnTrip = goTo(ctx, farmApproach(plan), 'returning to the farm site before grading', 12, 6);
        if (returnTrip) return returnTrip;
        return {
          start: 'build',
          args: { cells: groundwork.fill.slice(0, batch).map(cell => ({ ...cell, item: foundation.item })), timeoutMs: 600000 },
          why: 'leveling the farm platform from solid ground outward',
        };
      }
    }
    const fromChest = (item: string, count: number) => {
      const chest = allStashes(memory.notes).find(s => (s.seen?.items[item] ?? 0) > 0);
      if (!chest || count <= 0) return null;
      selectStash(memory, chest);
      return (
        goTo(ctx, chest, 'fetching stored farm supplies') ?? {
          start: 'take_items' as const,
          args: { target: chest.key, items: [{ item, count: Math.min(count, chest.seen.items[item]) }], timeoutMs: 300000 },
          why: 'use stored farm supplies before gathering more',
        }
      );
    };
    const soil = farmBeds(plan).filter(p => !fertileBed(ground(p))).length;
    const storedSoil = fromChest(plan.soil, soil - count(plan.soil));
    if (storedSoil) return storedSoil;
    if (count(plan.soil) < soil)
      return {
        start: 'harvest',
        args: { match: 'soil-medium-', item: 'game:soil-medium-none', count: soil - count(plan.soil), tool: 'Shovel', timeoutMs: 600000 },
        why: 'medium-fertility soil for the eight farm beds',
      };
    const fenceCode = `game:roughhewnfence-${plan.wood}-ew-free`;
    const gateCode = `game:roughhewnfencegate-${plan.wood}-n-closed-free`;
    const fences = Math.max(
      0,
      farmFence(plan).filter(p => !ground(p).startsWith(`game:roughhewnfence-${plan.wood}-`)).length - count(`game:roughhewnfence-${plan.wood}-`),
    );
    const gates = ground(farmGate(plan)).startsWith(`game:roughhewnfencegate-${plan.wood}-`)
      ? 0
      : Math.max(0, 1 - count(`game:roughhewnfencegate-${plan.wood}-`));
    if (fences || gates) {
      const storedFence = fromChest(fenceCode, fences) ?? fromChest(gateCode, gates);
      if (storedFence) return storedFence;
      const logs = Math.ceil(fences / 8) * 2 + gates * 4;
      const sticks = Math.ceil(fences / 8) * 2 + gates * 4;
      const haveLogs = k.slots
        .filter(s => s.code?.match(/^game:log-(?:grown|placed)-([a-z]+)-/)?.[1] === plan.wood)
        .reduce((n, s) => n + s.quantity, 0);
      for (const chest of allStashes(memory.notes))
        for (const code of Object.keys(chest.seen?.items ?? {})) {
          if (code.match(/^game:log-(?:grown|placed)-([a-z]+)-/)?.[1] !== plan.wood) continue;
          const storedLogs = fromChest(code, logs - haveLogs);
          if (storedLogs) return storedLogs;
        }
      if (haveLogs < logs)
        return {
          start: 'fell_tree',
          args: { count: logs - haveLogs, wood: plan.wood, timeoutMs: 600000 },
          why: `${plan.wood} logs for the farm fence and gate`,
        };
      const storedSticks = fromChest('game:stick', sticks - k.sticks);
      if (storedSticks) return storedSticks;
      if (k.sticks < sticks)
        return {
          start: 'gather',
          args: { match: 'stick', item: 'game:stick', count: sticks - k.sticks, timeoutMs: 300000 },
          why: 'sticks for the farm enclosure',
        };
      return {
        start: 'craft_item',
        args: { output: fences ? fenceCode : gateCode, count: fences || gates, timeoutMs: 300000 },
        why: fences ? 'rough-hewn fencing for the farm' : 'a gate for the farm entrance',
      };
    }
    if (plan.prepared) {
      for (const chest of allStashes(memory.notes))
        for (const code of Object.keys(chest.seen?.items ?? {})) {
          if (!/^game:seeds-/.test(code)) continue;
          const storedSeed = fromChest(code, 2 - count(code));
          if (storedSeed) return storedSeed;
        }
    }
    const trip = goTo(ctx, farmApproach(plan), 'returning to the farm', 8, 2);
    if (trip) return trip;
    return {
      start: 'farm',
      args: {
        origin: plan.origin,
        turn: plan.turn,
        soil: plan.soil,
        wood: plan.wood,
        rotation: plan.rotation,
        phase: plan.prepared ? 'tend' : 'prepare',
        timeoutMs: 1800000,
      },
      why: plan.prepared ? 'inspect crops, harvest, rotate and replant suitable beds' : 'prepare irrigated soil and a complete farm enclosure',
    };
  },
  ended: (last, memory, reading) => {
    if (last.kind === 'take_items') noteContents(memory, last, reading.now);
    if (last.ok && memory.notes.farm && ['build', 'dig_area', 'farm'].includes(last.kind)) delete memory.notes.farm.siteFailures;
    if (memory.notes.farm && !memory.notes.farm.prepared && last.kind === 'look_around') memory.notes.farm.surveyed = true;
    if (memory.notes.farm && !memory.notes.farm.prepared && last.kind === 'dig_area') memory.notes.farm.surveyed = false;
    if (last.kind !== 'farm' || !memory.notes.farm) return;
    const wasPrepared = memory.notes.farm.prepared;
    if (last.result?.prepared) memory.notes.farm.prepared = true;
    if (!last.ok) return;
    if (last.result.rotate) {
      memory.notes.farm.rotation = (memory.notes.farm.rotation + 1) % 4;
      memory.notes.farm.checkedAt = 0;
    } else memory.notes.farm.checkedAt = wasPrepared ? reading.now : 0;
  },
  // Grading is incremental world state. A partial clear or fill is recomputed
  // from the next observation instead of discarding a viable farm site.
  setAside: (last, memory, reading) => {
    const plan = memory.notes.farm;
    const siteFailed = !!plan && !plan.prepared && (last.reason === `brain: ${GUARDED_SITE}` || (last.kind === 'travel' && failedOnItsOwn(last)));
    if (siteFailed) {
      plan.siteFailures = (plan.siteFailures ?? 0) + 1;
      if (plan.siteFailures >= FARM_SITE_FAILURES) {
        rejectSite(memory, plan, reading.now);
        memory.notes.farm = null;
        return false;
      }
      return true;
    }
    return last.reason === `brain: ${GUARDED_SITE}` || (failedOnItsOwn(last) && !['dig_area', 'build'].includes(last.kind));
  },
  // A flight can carry the body outside the ordinary local retry radius while
  // the fixed farm itself remains guarded. Give that site the full cooldown.
  setAsideEverywhere: true,
};
