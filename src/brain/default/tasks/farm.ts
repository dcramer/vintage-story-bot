import { type Farm, farmApproach, farmBeds, farmFence, farmGate, farmSite, fertileBed } from '../../../support/farming.ts';
import type { Concern } from '../concern.ts';
import { allStashes, goTo, noteContents, selectStash } from '../concern.ts';

export type FarmNote = Farm & { soil: string; wood: string; rotation: number; prepared: boolean; checkedAt: number };
export const FARM_CHECK_MS = 5 * 60 * 1000;
const woods = new Set(['birch', 'oak', 'maple', 'pine', 'acacia', 'kapok', 'aged', 'baldcypress', 'larch', 'redwood', 'walnut']);

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
  run: ctx => {
    const { k, memory, reading } = ctx;
    let plan = memory.notes.farm;
    if (!plan) {
      const site = farmSite(reading.terrain, ctx.home ?? ctx.state.position);
      if (!site) return { start: 'explore', args: { legs: 1, timeoutMs: 180000 }, why: 'observed level shoreline for an irrigated fenced farm' };
      const carriedWood = k.slots.map(s => s.code?.match(/^game:log-(?:grown|placed)-([a-z]+)-/)?.[1]).find(w => woods.has(w));
      if (!carriedWood)
        return {
          start: 'fell_tree',
          args: { count: 8, timeoutMs: 600000 },
          why: 'choose the farm enclosure wood from locally gathered logs',
        };
      plan = memory.notes.farm = { ...site, soil: 'game:soil-medium-none', wood: carriedWood, rotation: 0, prepared: false, checkedAt: 0 };
    }
    const count = code => k.slots.filter(s => s.code?.includes(code)).reduce((n, s) => n + s.quantity, 0);
    const ground = p => reading.terrain?.get(p.x, p.y, p.z)?.code ?? '';
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
    if (last.kind !== 'farm' || !memory.notes.farm) return;
    const wasPrepared = memory.notes.farm.prepared;
    if (last.result?.prepared) memory.notes.farm.prepared = true;
    if (!last.ok) return;
    if (last.result.rotate) {
      memory.notes.farm.rotation = (memory.notes.farm.rotation + 1) % 4;
      memory.notes.farm.checkedAt = 0;
    } else memory.notes.farm.checkedAt = wasPrepared ? reading.now : 0;
  },
};
