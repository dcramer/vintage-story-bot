import { angle, distance, horizontal, lookAt } from '../runtime/navigation/terrain.ts';
import { changeBlock } from './blocks.ts';
import { emptyHand } from './food.ts';
import { nearestThreat } from './threats.ts';
import { has, traitsOf } from './traits.ts';

export const leafBlock = object => object?.kind === 'block' && has(object, 'leaves');

// The leaves around the body, read from the surroundings the eye reported with
// their codes. A canopy is bulk terrain, never a sighting, so it is read from
// the map of what is here, cell by cell, and never asked of the world.
export function nearbyLeaves(field, radius = 5) {
  const state = field.latest,
    p = state.position,
    eye = { ...p, y: p.y + (state.body?.eyeHeight ?? 1.6) },
    reach = state.pickingRange ?? 4.5,
    objects = [];
  const map = field.env.map;
  if (!map?.get) return objects;
  for (let x = Math.floor(p.x) - radius; x <= Math.floor(p.x) + radius; x++)
    for (let y = Math.floor(p.y) - radius; y <= Math.floor(p.y) + radius; y++)
      for (let z = Math.floor(p.z) - radius; z <= Math.floor(p.z) + radius; z++) {
        const cell = map.get(x, y, z);
        if (!cell?.code || !cell.traits?.includes('leaves')) continue;
        const point = { x: x + 0.5, y: y + 0.5, z: z + 0.5 },
          far = distance(eye, point);
        if (far > radius) continue;
        objects.push({
          kind: 'block',
          key: `block:0:${x}:${y}:${z}:${cell.code}`,
          code: cell.code,
          point,
          distance: +far.toFixed(2),
          traits: traitsOf({ kind: 'block', code: cell.code }),
          access: null,
          withinPickingRange: far <= reach,
          look: lookAt(eye, point),
        });
      }
  return objects;
}
export const threatAllowsLeafClearing = (state, threat, minimum = 12) => !threat || horizontal(state.position, threat.point) >= minimum;

export function leafClearCandidate(objects, state, toward, skipped = new Set()) {
  const direction = lookAt(state.position, toward).yawDegrees;
  const candidates = objects.filter(
    object =>
      !skipped.has(object.key) &&
      leafBlock(object) &&
      object.withinPickingRange &&
      object.access?.buildOrBreak !== false &&
      object.point.y >= state.position.y - 0.1 &&
      object.point.y <= state.position.y + state.body.height + 0.5 &&
      (Math.floor(object.point.x) !== Math.floor(state.position.x) || Math.floor(object.point.z) !== Math.floor(state.position.z)) &&
      // A nearest visible surface can be behind the player in a dense canopy.
      // Removing it cannot open the intended route and makes long trips carve
      // backwards. Sideways leaves may widen a gap, but never cut beyond
      // the destination-facing hemisphere.
      Math.abs(angle(lookAt(state.position, object.point).yawDegrees, direction)) <= 90,
  );
  const nearest = Math.min(...candidates.map(object => horizontal(object.point, state.position)));
  // Stay near the visible surface so a deep leaf cannot be occluded, then cut
  // the most useful opening through that near layer instead of hollowing the
  // entire canopy in arbitrary distance order.
  return (
    candidates
      .filter(object => horizontal(object.point, state.position) <= nearest + 1.25)
      .sort(
        (a, b) =>
          Math.abs(angle(lookAt(state.position, a.point).yawDegrees, direction)) -
            Math.abs(angle(lookAt(state.position, b.point).yawDegrees, direction)) ||
          horizontal(a.point, state.position) - horizontal(b.point, state.position) ||
          a.key.localeCompare(b.key),
      )[0] ?? null
  );
}

// Break only one explicitly observed leaf obstruction after deterministic
// pathfinding has already exhausted non-mutating local routes.
export async function clearLeaf(field, toward) {
  await field.observe(true);
  const threat = nearestThreat(field.latest);
  // A distant predator plus a leaf enclosure otherwise creates a permanent
  // deadlock: evasion has no route and leaf clearing refuses to open one. Preserve
  // a wide no-fieldwork perimeter while allowing one quick leaf beyond it.
  if (!threatAllowsLeafClearing(field.latest, threat) || !field.latest.capabilities?.includes('block_actions')) return false;
  const target = leafClearCandidate(nearbyLeaves(field), field.latest, toward, field.skipped);
  if (!target) return false;
  field.report('clearing_leaves', { target: target.key });
  try {
    const slot = await emptyHand(field);
    const result = await changeBlock(field, 'dig', { target: target.key, point: target.point, slot, expectedItem: null, timeoutMs: 8000 });
    if (result.ok) {
      field.seen.delete(target.key);
      field.skip(target, 300000);
      return true;
    }
  } catch {
    /* A changed/occluded leaf is simply not a verified clearing. */
  }
  field.skip(target, 120000);
  return false;
}

export async function clearLeafPath(field, toward, limit = 3) {
  let cleared = 0;
  while (cleared < limit && (await clearLeaf(field, toward))) cleared++;
  return cleared;
}
