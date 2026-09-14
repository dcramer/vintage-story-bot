import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { distance, horizontal } from '../runtime/navigation/terrain.ts';
import { changeBlock, replaceablePlant, selectCell } from '../support/blocks.ts';
import { diggingSlot } from '../support/digging.ts';
import { Gleaner, pickupBlock } from '../support/gleaning.ts';
import { equip, ownedSlots } from '../support/inventory.ts';
import { clearLeafPath, leafBlock } from '../support/leaf-clearing.ts';
import { presets } from '../support/structures.ts';
import { cleanName, runField } from '../support/task.ts';
import { has } from '../support/traits.ts';

const faces = { up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0], down: [0, -1, 0] };
const center = c => ({ x: c.x + 0.5, y: c.y + 0.5, z: c.z + 0.5 });
const sameColumn = (q, c) => Math.floor(q.x) === c.x && Math.floor(q.z) === c.z;
const reach = 4.2;

function facePoints(cell, offset) {
  const axes = ['x', 'y', 'z'];
  const tangent = axes.filter((_, i) => offset[i] === 0);
  const middle = Object.fromEntries(axes.map((axis, i) => [axis, cell[axis] + 0.5 + offset[i] * 0.49]));
  return [
    middle,
    ...[0.15, 0.85].flatMap(a => [0.15, 0.85].map(b => ({ ...middle, [tangent[0]]: cell[tangent[0]] + a, [tangent[1]]: cell[tangent[1]] + b }))),
  ];
}

async function eye(field) {
  const state = await field.observe();
  return { x: state.position.x, y: state.position.y + state.body.eyeHeight, z: state.position.z };
}

// Stand within native reach of a cell without occupying its column; returns false when no route exists.
export async function standNear(field, survival, cell, force = false, placing = false, preferredStandY = null, preferHigher = placing) {
  const from = await eye(field);
  // Placement face selection becomes unreliable at the very edge of native
  // reach. Digging can use the full range, but building first closes enough
  // distance to see a useful side of the support block.
  if (!force && distance(from, center(cell)) <= (placing ? 3 : reach)) return true;
  // Look over the work before seeking another viewpoint. From the access
  // stairs this reveals the roof's headroom, which was hidden from below.
  if (placing && force) await field.look({ ...center(cell), y: cell.y + 2 });
  const minimumEye = placing && force && preferHigher ? Math.max(from.y, cell.y + 0.5) : -Infinity;
  const destination = field.approach(
    { point: { ...center(cell), y: preferredStandY ?? cell.y + 0.5 }, kind: 'block' },
    q =>
      (sameColumn(q, cell) && Math.abs(q.y - cell.y) < 2.5) ||
      q.y + field.latest.body.eyeHeight < minimumEye ||
      distance({ ...q, y: q.y + field.latest.body.eyeHeight }, center(cell)) > reach,
    // Roof-access stairs can be three columns from the unfinished roof cell,
    // still within picking range. Do not limit placement to the search loop's
    // usual two-column harvesting approach.
    placing ? 4 : 2,
  );
  if (!destination) return false;
  const result = await field.walk(destination, survival?.pauseWhen);
  return ['arrived', 'paused'].includes(result.state);
}

function known(field, cell) {
  const entry = field.env.map.get(cell.x, cell.y, cell.z);
  return entry ? (entry.hazard ? 'hazard' : entry.boxes.length || (entry.code && entry.code !== 'game:air') ? 'solid' : 'air') : 'unknown';
}

// Native placement refuses blocks that the placed item would replace. Terrain
// memory can carry only geometry and a code, so consult both its reported
// traits and the handbook/prior traits derived from that code.
export const stablePlacementSupport = cell =>
  !!cell &&
  !cell.hazard &&
  (cell.boxes?.length > 0 || (!!cell.code && cell.code !== 'game:air')) &&
  !has(cell, 'replaceable') &&
  !has({ kind: 'block', code: cell.code }, 'replaceable');

// Native selection is newer evidence than terrain memory. A previous build can
// leave the map cache describing snow where a wall now stands, so validate the
// block under the crosshair rather than rejecting that face from stale traits.
export const selectedPlacementSupport = (remembered, selected) =>
  stablePlacementSupport(selected ? { ...remembered, ...selected, hazard: selected.hazard ?? null } : remembered);

export const selectedPlacementCell = (item, selected) =>
  !selected ? 'unknown' : selected.code === item ? 'placed' : replaceablePlant(selected.code) ? 'clear' : 'blocked';

// A replaceable block occupying a blueprint cell can be hidden behind the
// part of the shell already built. Verify it from the same close/lateral/high
// viewpoints used for placement instead of rejecting the cell after one ray.
export async function selectExistingPlacementCell(field, survival, cell) {
  for (let attempt = 0; attempt < 3; attempt++) {
    if (!(await standNear(field, survival, cell, attempt > 0, true, null, attempt > 1))) {
      if (attempt > 0) break;
      continue;
    }
    const selected = await selectCell(field, cell);
    if (selected) return selected;
  }
  return null;
}

export async function digArea(field, survival, { cells, tool, minTier = 0, order: requestedOrder = 'top-down' }) {
  const done = [],
    failed = [];
  const summary = () => ({ total: cells.length, dug: done.length, failed: failed.length, moved: +field.moved.toFixed(1) });
  const held = async selected => {
    const inventory = await field.send({ action: 'inventory' });
    if (tool === undefined) return diggingSlot(field, selected, inventory);
    const current = ownedSlots(inventory).find(s => s.inventory === 'hotbar' && s.slot === field.latest.activeSlot);
    if (current?.tool === tool && current.toolTier >= minTier && current.durability > 0) return current.slot;
    return (await equip(field, { tool, minTier })).slot;
  };
  const order =
    requestedOrder === 'given'
      ? [...cells]
      : [...cells].sort((a, b) => b.y - a.y || horizontal(center(a), field.latest.position) - horizontal(center(b), field.latest.position));
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
      // Exact leaf cells can be hidden behind the same canopy that prevents a
      // useful work position. Open one observed, reachable leaf toward the
      // requested cell before asking navigation to find another viewpoint.
      // This stays bounded by the normal dig retries and never clears around
      // soil, rock, or an unknown target.
      const remembered = field.env.map.get(cell.x, cell.y, cell.z);
      if (leafBlock(remembered ? { kind: 'block', ...remembered } : null)) {
        const cleared = await clearLeafPath(field, center(cell), 1);
        if (cleared) {
          await field.observe(true);
          if (known(field, cell) === 'air') {
            done.push({ ...cell, before: remembered.code });
            reason = null;
            break;
          }
        }
      }
      const preferredStandY = leafBlock(remembered ? { kind: 'block', ...remembered } : null) ? cell.y - field.latest.body.height : null;
      if (!(await standNear(field, survival, cell, attempt > 0, false, preferredStandY))) {
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
        const slot = await held(selected);
        result =
          slot === null
            ? { ok: false, reason: 'cannot_dig' }
            : await changeBlock(field, 'dig', { target: selected.key, slot, acceptTransform: true });
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

export async function build(field, survival, { cells, verifyExisting = false }) {
  const placed = [],
    failed = [];
  const summary = () => ({ total: cells.length, placed: placed.length, failed: failed.length, moved: +field.moved.toFixed(1) });
  for (const cell of cells) {
    await field.observe(true);
    await survival?.tend();
    const obstruction = field.env.map.get(cell.x, cell.y, cell.z);
    const loose = {
      kind: 'block',
      code: obstruction?.code,
      point: center(cell),
      key: `block:${field.latest.position.dimension ?? 0}:${cell.x}:${cell.y}:${cell.z}:${obstruction?.code}`,
    };
    if (pickupBlock(loose)) {
      if (!(await standNear(field, survival, cell)) || !(await new Gleaner(field).pickup(loose))) {
        failed.push({ ...cell, reason: 'pickup_obstructed' });
        continue;
      }
      const cleared = await field.until(
        async () => {
          await field.observe();
          return known(field, cell) === 'air';
        },
        { timeoutMs: 3000, everyMs: 200 },
      );
      if (!cleared.met) {
        failed.push({ ...cell, reason: 'pickup_not_cleared' });
        continue;
      }
    }
    let occupied = known(field, cell) === 'solid';
    if (occupied && verifyExisting && field.env.map.get(cell.x, cell.y, cell.z)?.code !== cell.item) {
      const selected = await selectExistingPlacementCell(field, survival, cell);
      const state = selectedPlacementCell(cell.item, selected);
      if (state === 'placed') {
        placed.push({ ...cell, skipped: 'occupied' });
        continue;
      }
      if (state === 'clear') {
        const inventory = await field.send({ action: 'inventory' });
        const slot = await diggingSlot(field, selected, inventory);
        let cleared;
        try {
          cleared =
            slot === null
              ? { ok: false, reason: 'cannot_dig' }
              : await changeBlock(field, 'dig', { target: selected.key, slot, acceptTransform: true });
        } catch (error) {
          if (/interruption|cancelled|deadline/i.test(error.message)) throw error;
          cleared = { ok: false, reason: error.message };
        }
        if (!cleared.ok) {
          failed.push({ ...cell, reason: cleared.reason });
          continue;
        }
        occupied = false;
      } else {
        failed.push({ ...cell, reason: state === 'unknown' ? 'not_selectable' : 'occupied' });
        continue;
      }
    }
    if (occupied) {
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
    // Try the current view, another lateral view, then the access stairs or
    // roof. Climbing directly onto a new support hides the side face needed
    // for the next block in a horizontal course.
    for (let attempt = 0; attempt < 3 && reason; attempt++) {
      if (!(await standNear(field, survival, cell, attempt > 0, true, null, attempt > 1))) {
        // No second place to stand keeps the first attempt's reason; it is what actually failed.
        if (attempt > 0) break;
        reason = 'no_stand_position';
        continue;
      }
      const faceOrder = Object.entries(faces).sort(([, a], [, b]) => {
        const support = offset => field.env.map.get(cell.x - offset[0], cell.y - offset[1], cell.z - offset[2]);
        return Number(stablePlacementSupport(support(b))) - Number(stablePlacementSupport(support(a)));
      });
      for (const [face, offset] of faceOrder) {
        const support = { x: cell.x - offset[0], y: cell.y - offset[1], z: cell.z - offset[2] };
        const rememberedSupport = field.env.map.get(support.x, support.y, support.z);
        let selected, point;
        for (const candidate of facePoints(support, offset)) {
          selected = await selectCell(field, support, { point: candidate, face, clearPlants: true });
          if (selectedPlacementSupport(rememberedSupport, selected)) {
            point = candidate;
            break;
          }
          selected = null;
        }
        if (!selected) {
          reason = 'support_not_selectable';
          continue;
        }
        let result;
        try {
          result = await changeBlock(field, 'place', { target: selected.key, point, face, slot, expectedItem: cell.item });
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
  title: args => (args.preset ? `Build ${cleanName(args.preset.kind)}` : `Build with ${args.cells.length} blocks`),
  announce: args => `Building a ${(args.preset?.kind ?? 'structure').replace(/[-_]/g, ' ')}.`,
  run: (env, { cells, preset, ...options }) =>
    runField(env, options, ['inventory', 'block_actions'], (field, survival) =>
      build(field, survival, { cells: cells ?? presets[preset.kind](preset.origin, preset.item) }),
    ),
});
