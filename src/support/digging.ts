import { failedEdges } from '../runtime/navigation/failed-edges.ts';
import { angle, horizontal, JUMP_HEADROOM, key, lookAt } from '../runtime/navigation/terrain.ts';
import { changeBlock, selectCell } from './blocks.ts';
import { equip, ownedSlots } from './inventory.ts';

// Getting out of a pit the way a player does: dig a staircase up through the
// wall toward where the trip is going. Only when the ground the bot can reach
// from where it stands runs out within a few dozen cells, and only through
// blocks the carried tools (or bare hands) can break.
export const pitLimit = 48;
const cardinals = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// How many standing cells can be reached from a node before the search runs out, capped at limit.
export function reachable(map, origin, limit = pitLimit) {
  const blocked = failedEdges(map);
  const seen = new Set([key(origin)]),
    queue = [origin];
  while (queue.length && seen.size < limit) {
    const at = queue.shift();
    for (const { node } of [...map.moves(at), ...map.gapMoves(at)]) {
      const id = key(node);
      if (blocked.has(`${key(at)}>${id}`)) continue;
      if (seen.has(id)) continue;
      seen.add(id);
      queue.push(node);
    }
  }
  return seen.size;
}

export const solid = (map, x, y, z) => {
  const c = map.get(x, y, z);
  return !!c && !c.hazard && c.boxes.some(b => b[4] - b[1] > 0.99 && b[3] - b[0] > 0.99 && b[5] - b[2] > 0.99);
};
export const known = (map, x, y, z) => !!map.get(x, y, z);

// A narrow pillar can have no wall to cut. Bridge one cardinal cell with
// carried soil, attached to observed solid support, then climb normally.
export function supportedSteps(map, node, toward) {
  const h = Math.floor(node.y),
    x = Math.floor(node.x),
    z = Math.floor(node.z);
  if (!map.clearBetween(x, z, node.y, node.y + JUMP_HEADROOM)) return [];
  const faces = { up: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0] };
  const heading = lookAt(node, toward).yawDegrees;
  return cardinals
    .flatMap(([dx, dz]) => {
      const cell = { x: x + dx, y: h, z: z + dz };
      const entry = map.get(cell.x, h, cell.z);
      if (
        !entry ||
        entry.hazard ||
        entry.boxes.length ||
        (entry.code && entry.code !== 'game:air') ||
        !map.clearBetween(cell.x, cell.z, h + 1, h + 1 + JUMP_HEADROOM)
      )
        return [];
      return Object.entries(faces).flatMap(([face, offset]) => {
        const support = { x: cell.x - offset[0], y: cell.y - offset[1], z: cell.z - offset[2] };
        return solid(map, support.x, support.y, support.z)
          ? [{ cell, support, face, off: Math.abs(angle(lookAt(node, { x: cell.x + 0.5, z: cell.z + 0.5, y: h }).yawDegrees, heading)) }]
          : [];
      });
    })
    .sort((a, b) => a.off - b.off);
}

async function placeStep(field, origin, toward, inventory) {
  const soil = ownedSlots(inventory).find(s => s.quantity > 0 && /^game:soil-[a-z]+-none$/.test(s.code ?? ''));
  if (!soil) return null;
  for (const { cell, support, face } of supportedSteps(field.env.map, origin, toward)) {
    const selected = await selectCell(field, support, { face });
    if (!selected) continue;
    const { slot } = await equip(field, { item: soil.code });
    field.report('building_step', { cell });
    const placed = await changeBlock(field, 'place', { target: selected.key, face, slot, expectedItem: soil.code });
    // An attempted mutation is never retried against a different support.
    return placed.ok ? { step: cell, dig: [], direction: null } : null;
  }
  return null;
}

// The first stair step toward a point: a cardinal neighbour whose cell at foot
// level is a solid block (the step) with solid blocks above it (the wall to cut).
// Returns the step cell and the cells to dig, in order, or null.
export function stairStep(map, node, toward, miningTier = Infinity) {
  const x = Math.floor(node.x),
    z = Math.floor(node.z),
    h = Math.floor(node.y);
  // Clear the takeoff headroom before reaching past it into the wall.
  // A sealed shaft otherwise hides the upper cuts and prevents the jump.
  const roof = map.get(x, h + 2, z);
  if (!roof || roof.hazard) return null;
  const ceiling = solid(map, x, h + 2, z) ? [{ x, y: h + 2, z }] : [];
  const canCut = cell => !map.get(cell.x, cell.y, cell.z).traits.some(trait => /^tier\d+$/.test(trait) && Number(trait.slice(4)) > miningTier);
  if (!ceiling.every(canCut)) return null;
  const heading = lookAt(node, toward).yawDegrees;
  const directions = cardinals
    .map(([dx, dz]) => ({ dx, dz, off: Math.abs(angle(lookAt(node, { x: node.x + dx, z: node.z + dz }).yawDegrees, heading)) }))
    .sort((a, b) => a.off - b.off);
  for (const { dx, dz } of directions) {
    const wx = x + dx,
      wz = z + dz;
    // The step itself is occluded by the wall above when the bot is inside a
    // one-cell shaft. Known air is unsafe; unknown may be planned, then must
    // be observed as solid after the wall is opened and before climbing.
    if (known(map, wx, h, wz) && !solid(map, wx, h, wz)) continue;
    const above = [h + 1, h + 2, h + 3];
    if (!above.every(y => known(map, wx, y, wz)) || above.some(y => map.get(wx, y, wz).hazard)) continue;
    const dig = above.filter(y => solid(map, wx, y, wz)).map(y => ({ x: wx, y, z: wz }));
    if (!dig.every(canCut)) continue;
    return { step: { x: wx, y: h, z: wz }, dig: [...ceiling, ...dig], direction: { dx, dz } };
  }
  // A low ceiling can prevent stepping onto surrounding snow even when no
  // full-height wall needs a staircase. Clear that observed obstruction first.
  return ceiling.length ? { step: null, dig: ceiling, direction: null } : null;
}

// Whether the selected block can be broken with what is carried; picks the tool slot when one is needed.
export async function diggingSlot(field, selected, inventory) {
  const tier = selected.requiredMiningTier ?? 0;
  const tool = tier > 0 ? 'Pickaxe' : ['Soil', 'Sand', 'Gravel', 'Snow'].includes(selected.material) ? 'Shovel' : null;
  if (!tool) return field.latest.activeSlot;
  const slots = ownedSlots(inventory);
  const usable = s => s.tool === tool && s.toolTier >= tier && s.durability > 0 && s.quantity > 0;
  const held = slots.find(s => s.inventory === 'hotbar' && usable(s));
  if (held) return held.slot;
  if (!slots.some(usable) || !slots.some(s => s.inventory === 'hotbar' && !s.code)) return tier > 0 ? null : field.latest.activeSlot;
  return (await equip(field, { tool, minTier: tier })).slot;
}

// Dig stairs toward a point until there is room to roam again.
export async function digOut(field, toward, { steps = 8 } = {}) {
  const map = field.env.map;
  let climbed = 0,
    reason = null;
  for (let step = 0; step < steps; step++) {
    const state = await field.observe(true);
    const origin = map.nodeAt(Math.floor(state.position.x), Math.floor(state.position.z), state.position.y, 0.6, 0.6);
    if (!origin) {
      reason = 'no_footing';
      break;
    }
    if (reachable(map, origin) >= pitLimit) {
      reason = null;
      break;
    }
    const inventory = await field.send({ action: 'inventory' });
    const slots = ownedSlots(inventory);
    const canEquip = slots.some(s => s.inventory === 'hotbar' && !s.code);
    const miningTier = Math.max(
      0,
      ...slots.filter(s => s.tool === 'Pickaxe' && s.durability > 0 && s.quantity > 0 && (s.inventory === 'hotbar' || canEquip)).map(s => s.toolTier),
    );
    let plan = stairStep(map, origin, toward, miningTier);
    if (!plan) {
      // A narrow shaft can hide its foot-level neighbours from the passive
      // terrain stream. Look directly at each wall once before concluding
      // there is no block from which to cut the next stair.
      field.report('surveying_exit', { at: origin });
      const h = Math.floor(origin.y),
        x = Math.floor(origin.x),
        z = Math.floor(origin.z);
      for (const [dx, dz] of cardinals) {
        const eye = { ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight };
        await field.aim(lookAt(eye, { x: x + dx + 0.5, y: h + 0.5, z: z + dz + 0.5 }));
      }
      plan = stairStep(map, origin, toward, miningTier);
    }
    if (!plan) plan = await placeStep(field, origin, toward, inventory);
    if (!plan) {
      reason = 'no_wall_to_cut';
      break;
    }
    field.report('digging_out', { step: climbed + 1, cell: plan.step, cells: plan.dig.length });
    let cut = true;
    for (const cell of plan.dig) {
      const selected = await selectCell(field, cell, { clearPlants: true });
      if (!selected) {
        cut = false;
        break;
      }
      const slot = await diggingSlot(field, selected, inventory);
      if (slot === null) {
        field.report('cannot_dig', { cell, code: selected.code, tier: selected.requiredMiningTier });
        cut = false;
        break;
      }
      const result = await changeBlock(field, 'dig', { target: selected.key, slot, acceptTransform: true, timeoutMs: 45000 });
      if (!result.ok) {
        field.report('cut_failed', { cell, code: selected.code, reason: result.reason });
        cut = false;
        break;
      }
    }
    if (!cut) {
      reason = 'cannot_cut';
      break;
    }
    // A cut cell is forgotten on change and known again only once the eye has seen it; look at
    // the opening until the map holds every cell, then the step is an ordinary jump up.
    const seen = () => (!plan.step || map.get(plan.step.x, plan.step.y, plan.step.z)) && plan.dig.every(cell => map.get(cell.x, cell.y, cell.z));
    for (let looks = 0; looks < 6 && !seen(); looks++) {
      const eye = { ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight };
      const opening = plan.step ?? plan.dig[0];
      await field.aim(lookAt(eye, { x: opening.x + 0.5, y: opening.y + 0.5, z: opening.z + 0.5 }));
      await field.wait(400);
      await field.observe(true);
    }
    if (!seen()) {
      reason = 'cut_not_seen';
      break;
    }
    if (!plan.step) continue;
    if (!solid(map, plan.step.x, plan.step.y, plan.step.z)) {
      reason = 'no_step';
      break;
    }
    // Snow at the starting cell need not exist on the new step. Use the
    // observed landing surface, not the starting height plus one block.
    const landing = map.nodeAt(plan.step.x, plan.step.z, plan.step.y + 1, 0.6, 0.6);
    if (!landing || landing.y <= origin.y) {
      reason = 'no_landing';
      break;
    }
    const up = await field.walk({ x: plan.step.x + 0.5, y: landing.y, z: plan.step.z + 0.5, arrivalRadius: 0.3 });
    // Reaching the checkpoint can finish while the jump is still landing.
    for (let i = 0; i < 6 && !field.latest.motion.onGround; i++) {
      await field.wait(200);
      await field.observe();
    }
    const stepCenter = { x: plan.step.x + 0.5, z: plan.step.z + 0.5 };
    if (
      !['arrived', 'paused'].includes(up.state) ||
      horizontal(field.latest.position, stepCenter) > 0.8 ||
      Math.abs(field.latest.position.y - landing.y) > 0.1 ||
      !field.latest.motion.onGround
    ) {
      reason = 'cannot_climb';
      break;
    }
    climbed++;
    reason = 'still_enclosed';
  }
  const here = map.nodeAt(Math.floor(field.latest.position.x), Math.floor(field.latest.position.z), field.latest.position.y, 0.6, 0.6);
  const free = !!here && reachable(map, here) >= pitLimit;
  return {
    ok: free,
    goal: 'dig_out',
    climbed,
    ...(free ? {} : { reason: reason ?? 'still_enclosed' }),
    position: field.latest.position,
    verification: 'client_observed',
  };
}
