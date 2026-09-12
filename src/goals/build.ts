import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { distance, horizontal } from '../runtime/navigation/terrain.ts';
import { changeBlock, selectCell } from '../support/blocks.ts';
import { equip, ownedSlots } from '../support/inventory.ts';
import { presets } from '../support/structures.ts';
import { runField } from '../support/task.ts';

const faces = { up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], down: [0, -1, 0] };
const center = c => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const sameColumn = (q, c) => Math.floor(q.x) === c.x && Math.floor(q.z) === c.z;
const reach = 4.2;

async function eye(field) {
  const state = await field.observe();
  return { x: state.position.x, y: state.position.y + state.body.eyeHeight, z: state.position.z };
}

// Stand within native reach of a cell without occupying its column; returns false when no route exists.
async function standNear(field, survival, cell, force = false) {
  if (!force && distance(await eye(field), center(cell)) <= reach) return true;
  const destination = field.approach({ point: center(cell), kind: 'block' }, q => sameColumn(q, cell) && Math.abs(q.y - cell.y) < 2.5);
  if (!destination) return false;
  const result = await field.walk(destination, survival?.pauseWhen);
  return ['arrived', 'paused'].includes(result.state);
}

function known(field, cell) {
  const entry = field.env.map.get(cell.x, cell.y, cell.z);
  return entry ? (entry.hazard ? 'hazard' : entry.boxes.length ? 'solid' : 'air') : 'unknown';
}

export async function digArea(field, survival, { cells, tool, minTier = 0 }) {
  const done = [],
    failed = [];
  const summary = () => ({ total: cells.length, dug: done.length, failed: failed.length, moved: +field.moved.toFixed(1) });
  const held = async () => {
    if (tool === undefined) return undefined;
    const inventory = await field.send({ action: 'inventory' });
    const current = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === field.latest.activeSlot);
    if (current?.tool === tool && current.toolTier >= minTier && current.durability > 0) return current.slot;
    return (await equip(field, { tool, minTier })).slot;
  };
  const order = [...cells].sort((a, b) => b.y - a.y || horizontal(center(a), field.latest.position) - horizontal(center(b), field.latest.position));
  for (const cell of order) {
    await field.observe(true);
    await survival?.tend();
    if (known(field, cell) === 'air') {
      done.push({ ...cell, skipped: 'air' });
      continue;
    }
    field.report('digging', { cell, ...summary() });
    let reason = 'no_stand_position';
    for (let attempt = 0; attempt < 3; attempt++) {
      if (!(await standNear(field, survival, cell, attempt > 0))) {
        // No second place to stand keeps the first attempt's reason; it is what actually failed.
        if (attempt > 0) break;
        reason = 'no_stand_position';
        continue;
      }
      const state = await field.observe();
      if (sameColumn(state.position, cell) && Math.abs(state.position.y - (cell.y + 1)) < 0.1) {
        reason = 'own_footing';
        continue;
      }
      const selected =
        (await selectCell(field, cell, { clearPlants: true })) ??
        (await selectCell(field, cell, { point: { x: cell.x + 0.5, y: cell.y + 0.98, z: cell.z + 0.5 }, clearPlants: true }));
      if (!selected) {
        reason = 'not_selectable';
        continue;
      }
      let result;
      try {
        result = await changeBlock(field, 'dig', { target: selected.key, slot: await held(), acceptTransform: true });
      } catch (error) {
        if (/interruption|cancelled|deadline|Selected item changed/i.test(error.message)) throw error;
        result = { ok: false, reason: error.message };
      }
      if (result.ok) {
        done.push({ ...cell, before: result.before });
        reason = null;
        break;
      }
      reason = result.reason;
    }
    if (reason) failed.push({ ...cell, reason });
  }
  return {
    ok: failed.length === 0,
    goal: 'dig_area',
    ...(failed.length ? { reason: failed[0].reason } : {}),
    ...summary(),
    failed,
    verification: 'client_observed',
  };
}

export async function build(field, survival, { cells }) {
  const placed = [],
    failed = [];
  const summary = () => ({ total: cells.length, placed: placed.length, failed: failed.length, moved: +field.moved.toFixed(1) });
  for (const cell of cells) {
    await field.observe(true);
    await survival?.tend();
    if (known(field, cell) === 'solid') {
      placed.push({ ...cell, skipped: 'occupied' });
      continue;
    }
    field.report('placing', { cell, ...summary() });
    let slot;
    try {
      slot = (await equip(field, { item: cell.item })).slot;
    } catch (error) {
      if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
      return {
        ok: false,
        goal: 'build',
        reason: 'out_of_material',
        item: cell.item,
        ...summary(),
        failed,
        remaining: cells.length - placed.length - failed.length,
      };
    }
    let reason = 'no_support';
    for (let attempt = 0; attempt < 2 && reason; attempt++) {
      if (!(await standNear(field, survival, cell, attempt > 0))) {
        // No second place to stand keeps the first attempt's reason; it is what actually failed.
        if (attempt > 0) break;
        reason = 'no_stand_position';
        continue;
      }
      for (const [face, offset] of Object.entries(faces)) {
        const support = { x: cell.x - offset[0], y: cell.y - offset[1], z: cell.z - offset[2] };
        if (known(field, support) !== 'solid') continue;
        const point = { x: support.x + 0.5 + offset[0] * 0.5, y: support.y + 0.5 + offset[1] * 0.5, z: support.z + 0.5 + offset[2] * 0.5 };
        const selected = await selectCell(field, support, { point, face, clearPlants: true });
        if (!selected) {
          reason = 'support_not_selectable';
          continue;
        }
        let result;
        try {
          result = await changeBlock(field, 'place', { target: selected.key, face, slot, expectedItem: cell.item });
        } catch (error) {
          if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
          result = { ok: false, reason: error.message };
        }
        if (result.ok) {
          placed.push({ ...cell, face, code: result.after ?? null });
          reason = null;
          break;
        }
        reason = result.reason;
      }
    }
    if (reason) failed.push({ ...cell, reason });
  }
  return {
    ok: failed.length === 0,
    goal: 'build',
    ...(failed.length ? { reason: failed[0].reason } : {}),
    ...summary(),
    // Each cell placed, with the block the client observed there; a container placed this way is found again by its code.
    built: placed,
    failed,
    verification: 'client_observed',
  };
}

const cell = z.object({ x: z.number().int(), y: z.number().int(), z: z.number().int() }).strict();
const item = z.string().min(1).max(160);

export default defineGoal({
  name: 'build',
  schema: z
    .object({
      cells: z.array(cell.extend({ item })).min(1).max(8).optional().describe('Explicit placements in order (request size limits lists).'),
      preset: z
        .object({
          kind: z
            .enum(['house', 'pit_kiln'])
            .describe(
              'house: getting-started 10x7 rammed-earth spec, origin = floor-level corner, long axis +x, door at x+4 on the +z wall. pit_kiln: plus around origin (the pit cell) on the surface.',
            ),
          origin: cell,
          item: item.describe('Block item code to place, e.g. game:rammed-light-plain.'),
        })
        .strict()
        .optional(),
      manageFood: z.boolean().default(false),
      sprint: z.boolean().default(false),
      timeoutMs: z.number().int().min(1000).max(3600000).default(1800000),
    })
    .strict()
    .refine(a => (a.cells !== undefined) !== (a.preset !== undefined), 'Supply exactly one of cells or preset'),
  destructive: true,
  description:
    'Place blocks cell by cell from own inventory: equip the item, stand within reach off the destination column, pick a known ' +
    'solid support face, place once and verify (one item consumed in survival). Occupied cells are skipped; failures are reported ' +
    'per cell; stops on out_of_material. No terrain clearing or scaffolding. Returns START; poll goal_status.',
  announce: args => `Building a ${(args.preset?.kind ?? 'structure').replace(/[-_]/g, ' ')}.`,
  run: (env, { cells, preset, ...options }) =>
    runField(env, options, ['inventory', 'block_actions'], (field, survival) =>
      build(field, survival, { cells: cells ?? presets[preset.kind](preset.origin, preset.item) }),
    ),
});
