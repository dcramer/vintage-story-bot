import { angle, horizontal, key, lookAt } from '../runtime/navigation/terrain.ts';
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
  const seen = new Set([key(origin)]),
    queue = [origin];
  while (queue.length && seen.size < limit) {
    const at = queue.shift();
    for (const { node } of [...map.moves(at), ...map.gapMoves(at)]) {
      const id = key(node);
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

// The first stair step toward a point: a cardinal neighbour whose cell at foot
// level is a solid block (the step) with solid blocks above it (the wall to cut).
// Returns the step cell and the cells to dig, in order, or null.
export function stairStep(map, node, toward) {
  const x = Math.floor(node.x),
    z = Math.floor(node.z),
    h = Math.floor(node.y);
  const heading = lookAt(node, toward).yawDegrees;
  const directions = cardinals
    .map(([dx, dz]) => ({ dx, dz, off: Math.abs(angle(lookAt(node, { x: node.x + dx, z: node.z + dz }).yawDegrees, heading)) }))
    .sort((a, b) => a.off - b.off);
  for (const { dx, dz } of directions) {
    const wx = x + dx,
      wz = z + dz;
    if (!solid(map, wx, h, wz)) continue;
    const above = [h + 1, h + 2, h + 3];
    if (!above.every(y => known(map, wx, y, wz)) || above.some(y => map.get(wx, y, wz).hazard)) continue;
    const dig = above.filter(y => solid(map, wx, y, wz)).map(y => ({ x: wx, y, z: wz }));
    if (!dig.length) continue;
    return { step: { x: wx, y: h, z: wz }, dig, direction: { dx, dz } };
  }
  return null;
}

// Whether the selected block can be broken with what is carried; picks the tool slot when one is needed.
export async function diggingSlot(field, selected, inventory) {
  const tier = selected.requiredMiningTier ?? 0;
  if (!(tier > 0)) return field.latest.activeSlot;
  const pick = ownedSlots(inventory).find(s => s.tool === 'Pickaxe' && s.toolTier >= tier && s.durability > 0);
  if (!pick) return null;
  return (await equip(field, { tool: 'Pickaxe', minTier: tier })).slot;
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
    let plan = stairStep(map, origin, toward);
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
      plan = stairStep(map, origin, toward);
    }
    if (!plan) {
      reason = 'no_wall_to_cut';
      break;
    }
    field.report('digging_out', { step: climbed + 1, cell: plan.step, cells: plan.dig.length });
    const inventory = await field.send({ action: 'inventory' });
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
    const seen = () => plan.dig.every(cell => map.get(cell.x, cell.y, cell.z));
    for (let looks = 0; looks < 6 && !seen(); looks++) {
      const eye = { ...field.latest.position, y: field.latest.position.y + field.latest.body.eyeHeight };
      await field.aim(lookAt(eye, { x: plan.step.x + 0.5, y: plan.dig[0].y + 0.5, z: plan.step.z + 0.5 }));
      await field.wait(400);
      await field.observe(true);
    }
    if (!seen()) {
      reason = 'cut_not_seen';
      break;
    }
    const up = await field.walk({ x: plan.step.x + 0.5, y: origin.y + 1, z: plan.step.z + 0.5, arrivalRadius: 0.3 });
    if (!['arrived', 'paused'].includes(up.state) || horizontal(field.latest.position, plan.step) > 0.8) {
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
