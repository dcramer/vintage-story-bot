import { angle, horizontal, lookAt } from '../navigation/terrain.mjs';
import { changeBlock } from './blocks.mjs';
import { emptyHand } from './food.mjs';
import { nearestThreat } from './threats.mjs';

export const foliageBlock = object => object?.kind === 'block' &&
  /^game:leaves(?:branchy)?-/.test(object.code ?? '');
export const threatAllowsClearance = (state, threat, minimum = 12) => !threat ||
  horizontal(state.position, threat.point) >= minimum;

export function foliageClearCandidate(objects, state, toward, rejected = new Set()) {
  const direction = lookAt(state.position, toward).yawDegrees;
  const candidates = objects.filter(object => !rejected.has(object.key) && foliageBlock(object) && object.withinPickingRange &&
      object.access?.buildOrBreak !== false && object.point.y >= state.position.y - .1 &&
      object.point.y <= state.position.y + state.body.height + .5 &&
      (Math.floor(object.point.x) !== Math.floor(state.position.x) ||
        Math.floor(object.point.z) !== Math.floor(state.position.z)) &&
      // A nearest visible surface can be behind the player in a dense canopy.
      // Removing it cannot open the intended route and makes long trips carve
      // backwards. Sideways leaves may widen a corridor, but never cut beyond
      // the destination-facing hemisphere.
      Math.abs(angle(lookAt(state.position, object.point).yawDegrees, direction)) <= 90);
  const nearest = Math.min(...candidates.map(object => horizontal(object.point, state.position)));
  // Stay near the visible surface so a deep leaf cannot be occluded, then cut
  // the most useful corridor through that near layer instead of hollowing the
  // entire canopy in arbitrary distance order.
  return candidates.filter(object => horizontal(object.point, state.position) <= nearest + 1.25)
    .sort((a, b) => Math.abs(angle(lookAt(state.position, a.point).yawDegrees, direction)) -
      Math.abs(angle(lookAt(state.position, b.point).yawDegrees, direction)) ||
      horizontal(a.point, state.position) - horizontal(b.point, state.position) || a.key.localeCompare(b.key))[0] ?? null;
}

// Break only one explicitly observed leaf obstruction after deterministic
// pathfinding has already exhausted non-mutating local routes.
export async function clearFoliage(field, toward) {
  await field.observe(true);
  const threat = nearestThreat(field.latest);
  // A distant predator plus a leaf enclosure otherwise creates a permanent
  // deadlock: evasion has no route and clearance refuses to open one. Preserve
  // a wide no-fieldwork perimeter while allowing one quick leaf beyond it.
  if (!threatAllowsClearance(field.latest, threat) || !field.latest.capabilities?.includes('block_actions')) return false;
  const objects = await field.scan(5, ['leaves-', 'leavesbranchy-'], 'blocks');
  const target = foliageClearCandidate(objects, field.latest, toward, field.rejected);
  if (!target) return false;
  field.report('clearing_foliage', { target: target.key });
  try {
    const slot = await emptyHand(field);
    const result = await changeBlock(field, 'dig', { target: target.key, point: target.point,
      slot, expectedItem: null, timeoutMs: 8000 });
    if (result.ok) {
      field.seen.delete(target.key);
      field.reject(target, 300000);
      return true;
    }
  } catch { /* A changed/occluded leaf is simply not a verified clearance. */ }
  field.reject(target, 120000);
  return false;
}

export async function clearFoliagePath(field, toward, limit = 3) {
  let cleared = 0;
  while (cleared < limit && await clearFoliage(field, toward)) cleared++;
  return cleared;
}
