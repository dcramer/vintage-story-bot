import { angle, horizontal, lookAt } from '../navigation/terrain.mjs';
import { changeBlock } from './blocks.mjs';
import { emptyHand } from './food.mjs';
import { nearestThreat } from './threats.mjs';

export const foliageBlock = object => object?.kind === 'block' &&
  /^game:leaves(?:branchy)?-/.test(object.code ?? '');

export function foliageClearCandidate(objects, state, toward) {
  const direction = lookAt(state.position, toward).yawDegrees;
  return objects.filter(object => foliageBlock(object) && object.withinPickingRange &&
      object.access?.buildOrBreak !== false && object.point.y >= state.position.y - .1 &&
      object.point.y <= state.position.y + state.body.height + .5 &&
      (Math.floor(object.point.x) !== Math.floor(state.position.x) ||
        Math.floor(object.point.z) !== Math.floor(state.position.z)))
    .sort((a, b) => Math.abs(angle(a.look.yawDegrees, direction)) - Math.abs(angle(b.look.yawDegrees, direction)) ||
      horizontal(a.point, state.position) - horizontal(b.point, state.position) || a.key.localeCompare(b.key))[0] ?? null;
}

// Break only one explicitly observed leaf obstruction after deterministic
// pathfinding has already exhausted non-mutating local routes.
export async function clearFoliage(field, toward) {
  await field.observe(true);
  if (nearestThreat(field.latest) || !field.latest.capabilities.includes('block_actions')) return false;
  const objects = await field.scan(5, ['leaves-', 'leavesbranchy-'], 'blocks');
  const target = foliageClearCandidate(objects, field.latest, toward);
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
