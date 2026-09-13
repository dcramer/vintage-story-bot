import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { selectCell } from '../support/blocks.ts';
import { cropRequirements } from '../support/crops.ts';
import { type Farm, farmApproach, farmBeds, farmCell, farmFence, farmGate, farmMargin, farmWatered, fertileBed } from '../support/farming.ts';
import { itemCount, ownedSlots } from '../support/inventory.ts';
import { surfaceCover } from '../support/sites.ts';
import { runField } from '../support/task.ts';
import { build, digArea } from './build.ts';
import { collectItem } from './collect_item.ts';
import { plant } from './plant.ts';
import { travel } from './travel.ts';
import { useOnBlock } from './use_block.ts';

const air = b => b && !b.hazard && !b.boxes.length && (!b.code || b.code === 'game:air');

export async function tendFarm(field, survival, options) {
  const { origin, turn, soil, wood, rotation, phase } = options;
  const farm: Farm = { origin, turn };
  const get = p => field.env.map.get(p.x, p.y, p.z);
  const failure = (reason, extra = {}) => ({ ok: false, goal: 'farm', reason, origin, turn, ...extra });
  const trip = await travel(field, survival, { ...farmApproach(farm), arrivalRadius: 0.5 });
  if (!trip.ok) return { ...trip, goal: 'farm', origin, turn };
  await field.observe(true);
  if (!farmWatered(field.env.map, farm)) return failure('irrigation_not_observed');
  const gate = farmGate(farm);
  const fence = farmFence(farm);
  const gateCode = `game:roughhewnfencegate-${wood}-n-closed-free`;
  const fenceCode = `game:roughhewnfence-${wood}-ew-free`;
  // Clear the jump margin as well as the beds: snow against a fence is a step.
  const cover = [];
  for (const p of farmMargin(farm)) {
    const b = get(p);
    const ours =
      (p.x === gate.x && p.z === gate.z && b?.code?.startsWith(`game:roughhewnfencegate-${wood}-`)) ||
      (fence.some(c => c.x === p.x && c.z === p.z) && b?.code?.startsWith(`game:roughhewnfence-${wood}-`));
    const crop = farmBeds(farm).some(c => c.x === p.x && c.z === p.z) && /^game:(crop-|deadcrop)/.test(b?.code ?? '');
    if (surfaceCover(b)) cover.push(p);
    else if (!air(b) && !ours && !crop) return failure('farm_obstructed', { cell: p });
    const overhead = get({ ...p, y: p.y + 1 });
    if (!air(overhead)) return failure('farm_headroom_unknown_or_blocked', { cell: p });
  }
  if (cover.length) {
    const cleared = await digArea(field, survival, { cells: cover, tool: undefined });
    if (!cleared.ok) return { ...cleared, goal: 'farm', origin, turn };
  }
  for (const p of farmBeds(farm)) {
    await field.observe();
    const b = get(p);
    if (fertileBed(b?.code)) continue;
    if (!/^game:soil-(low|verylow)-/.test(b?.code ?? '') && !air(b)) return failure('bed_soil_unknown_or_occupied', { cell: p });
    if (itemCount(await field.send({ action: 'inventory' }), soil) < 1) return failure('missing_soil', { item: soil });
    if (!air(b)) {
      const dug = await digArea(field, survival, { cells: [p], tool: 'Shovel' });
      if (!dug.ok) return { ...dug, goal: 'farm', origin, turn };
    }
    const placed = await build(field, survival, { cells: [{ ...p, item: soil }], verifyExisting: true });
    if (!placed.ok) return { ...placed, goal: 'farm', origin, turn };
  }
  const missing = [];
  for (const p of fence) {
    const b = get(p);
    if (b?.code?.startsWith(`game:roughhewnfence-${wood}-`)) continue;
    if (!air(b)) return failure('fence_cell_occupied_or_unknown', { cell: p });
    missing.push({ ...p, item: fenceCode });
  }
  if (missing.length) {
    const built = await build(field, survival, { cells: missing });
    if (!built.ok) return { ...built, goal: 'farm', origin, turn };
  }
  // Native placement chooses orientation from the player's position.
  const approach = await travel(field, survival, { ...farmApproach(farm), arrivalRadius: 0.5 });
  if (!approach.ok) return { ...approach, goal: 'farm', origin, turn };
  if (!get(gate)?.code?.startsWith(`game:roughhewnfencegate-${wood}-`)) {
    if (!air(get(gate))) return failure('gate_cell_occupied_or_unknown');
    const built = await build(field, survival, { cells: [{ ...gate, item: gateCode }] });
    if (!built.ok) return { ...built, goal: 'farm', origin, turn };
  }
  await field.observe();
  if (!get(gate)?.code?.startsWith(`game:roughhewnfencegate-${wood}-${turn % 2 ? 'w' : 'n'}-`)) return failure('gate_orientation');
  const operateGate = async (state: 'opened' | 'closed') => {
    const selected = await selectCell(field, gate);
    if (!selected?.code?.startsWith(`game:roughhewnfencegate-${wood}-`)) return false;
    if (selected.code.includes(`-${state}-`)) return true;
    const result = await useOnBlock(field, { target: selected.key, item: null, holdMs: 150, expectAfter: `-${state}-` });
    return result.ok;
  };
  if (!(await operateGate('opened'))) return failure('gate_not_open');
  const center = farmCell(farm, 2, 2);
  const entered = await travel(field, survival, { x: center.x + 0.5, y: origin.y, z: center.z + 0.5, arrivalRadius: 0.5 });
  if (!entered.ok) return { ...entered, goal: 'farm', origin, turn };
  const finish = async result => {
    const left = await travel(field, survival, { ...farmApproach(farm), arrivalRadius: 0.5 });
    if (!left.ok) return { ...left, goal: 'farm', origin, turn };
    if (!(await operateGate('closed'))) return failure('gate_not_closed');
    await field.observe();
    if (!fence.every(p => get(p)?.code?.startsWith(`game:roughhewnfence-${wood}-`))) return failure('fence_not_verified');
    const prepared = farmBeds(farm).every(p => get(p)?.code?.startsWith('game:farmland-'));
    return { ...result, goal: 'farm', origin, turn, prepared, verification: 'observed_beds,fence,gate' };
  };
  const inventory = await field.send({ action: 'inventory' });
  const hoe = ownedSlots(inventory).find(s => s.tool === 'Hoe' && s.durability > 0);
  if (!hoe) return finish(failure('missing_hoe'));
  // Every enclosed ground cell is tilled, including the fallow bed; grass soil
  // inside a fence would still allow hares to spawn among the crops.
  for (const p of farmBeds(farm)) {
    await field.observe();
    if (get(p)?.code?.startsWith('game:farmland-')) continue;
    const selected = await selectCell(field, p, { face: 'up' });
    if (!selected || !fertileBed(selected.code)) return finish(failure('bed_not_selectable', { cell: p }));
    const tilled = await useOnBlock(field, { target: selected.key, item: hoe.code, face: 'up', holdMs: 1200, expectAfter: 'game:farmland-' });
    if (!tilled.ok) return finish({ ...tilled, ok: false });
  }
  if (phase === 'prepare') return finish({ ok: true, planted: 0, harvested: 0 });
  let harvested = 0,
    growing = 0,
    planted = 0;
  for (const bed of farmBeds(farm)) {
    const p = { x: bed.x, y: bed.y + 1, z: bed.z };
    await field.observe();
    const b = get(p);
    if (air(b)) continue;
    if (!/^game:(crop-|deadcrop)/.test(b?.code ?? '')) return finish(failure('bed_not_clear', { cell: p }));
    const selected = await selectCell(field, p);
    if (!selected) return finish(failure('crop_not_selectable', { cell: p }));
    const stage = selected?.info?.match(/Growth Stage:\s*(\d+)\s*\/\s*(\d+)/);
    if (!b.code.startsWith('game:deadcrop') && (!stage || Number(stage[1]) < Number(stage[2]))) {
      growing++;
      continue;
    }
    if (ownedSlots(await field.send({ action: 'inventory' })).filter(s => !s.bag && !s.code).length < 2)
      return finish(failure('harvest_inventory_full'));
    const page = await field.send({ action: 'item_info', code: selected.code });
    const wanted = new Set((page.drops ?? []).map(d => d.code));
    if (!wanted.size) return finish(failure('crop_drops_unknown', { cell: p }));
    const before = await field.send({ action: 'inventory' });
    const dug = await digArea(field, survival, { cells: [p], tool: 'Knife' });
    if (!dug.ok) return finish({ ...dug, ok: false });
    for (const drop of await field.scan(4, undefined, 'items')) {
      if (!wanted.has(drop.code) || Math.hypot(drop.point.x - p.x - 0.5, drop.point.z - p.z - 0.5) > 2) continue;
      await collectItem(field, { target: drop.key, expectedItem: drop.code, radius: 4 });
    }
    const after = await field.send({ action: 'inventory' });
    if ([...wanted].some((code: string) => itemCount(after, code) > itemCount(before, code))) harvested++;
    else return finish(failure('harvest_not_verified'));
  }
  // Let the brain rotate the bed groups before any new planting after a cycle.
  if (harvested || growing) return finish({ ok: true, harvested, planted, growing, rotate: harvested > 0 && growing === 0 });
  const seeds = [];
  for (const code of new Set(
    ownedSlots(await field.send({ action: 'inventory' }))
      .map(s => s.code)
      .filter(c => /^game:seeds-/.test(c ?? '')),
  )) {
    const crop = cropRequirements(await field.send({ action: 'item_info', code }));
    if (crop) seeds.push({ code, ...crop });
  }
  const deferred = [];
  for (const bed of farmBeds(farm)) {
    await field.observe();
    if (!air(get({ ...bed, y: bed.y + 1 }))) continue;
    const nutrient = ['N', 'P', 'K', null][(bed.bed + rotation) % 4];
    if (!nutrient) continue;
    const carried = await field.send({ action: 'inventory' });
    const seed = seeds.find(s => s.nutrient === nutrient && itemCount(carried, s.code) > 0);
    if (!seed) continue;
    const selected = await selectCell(field, bed, { face: 'up' });
    if (!selected) return finish(failure('bed_not_selectable', { cell: bed }));
    const result = await plant(field, { target: selected.key, item: seed.code });
    if (result.ok) planted++;
    else if (['unsuitable_temperature', 'dry_farmland', 'depleted_nutrient'].includes(result.reason)) deferred.push(result.reason);
    else return finish(result);
  }
  return finish({ ok: true, planted, harvested, growing, deferred });
}

export default defineGoal({
  name: 'farm',
  schema: z
    .object({
      origin: z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict(),
      turn: z.number().int().min(0).max(3).default(0),
      phase: z.enum(['prepare', 'tend']).default('tend'),
      soil: z
        .string()
        .regex(/^game:soil-(medium|high|compost)-none$/)
        .default('game:soil-medium-none'),
      wood: z
        .string()
        .regex(/^[a-z]+$/)
        .default('pine'),
      rotation: z.number().int().min(0).max(3).default(0),
      timeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
    })
    .strict(),
  destructive: true,
  description:
    'Prepare or tend an owned 6x4 fenced shoreline farm: replace poor bed soil, repair fencing, operate its gate, till all eight beds, harvest mature crops and plant by handbook N/P/K requirements. Requires observed freshwater at bed height and carried supplies. Returns rotation readiness; never assumes crops will grow in winter.',
  title: args => `${args.phase === 'prepare' ? 'Prepare' : 'Tend'} the farm`,
  announce: () => 'Working on the fenced farm.',
  run: (env, options) =>
    runField(env, options, ['inventory', 'item_info', 'inspect_target', 'environment', 'block_facts', 'block_actions'], (field, survival) =>
      tendFarm(field, survival, options),
    ),
});
