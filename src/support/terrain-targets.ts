import { distance } from '../runtime/navigation/terrain.ts';

// Bulk blocks are terrain, not sightings. Nearby cells must have been observed
// recently before a goal can act on them. Callers may also opt into distant
// remembered cells as navigation leads; those disappear inside observation
// range unless the eye confirms them again, so stale memory is never acted on.
export function terrainTargets(field, matches: string[], memoryRange = 0) {
  const state = field.latest;
  const eye = { ...state.position, y: state.position.y + (state.body?.eyeHeight ?? 1.6) };
  const now = field.now();
  const objects = [];
  for (const cell of field.env.map?.cells.values() ?? []) {
    if (!cell.code || cell.hazard || !Number.isFinite(cell.seenAt) || !matches.some(match => cell.code.includes(match))) continue;
    const point = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
    const range = distance(eye, point);
    const current = now - cell.seenAt <= 5000;
    const rememberedLead = memoryRange > 8 && range > 8 && range <= memoryRange;
    if ((!current || range > 8) && !rememberedLead) continue;
    objects.push({
      kind: 'block',
      key: `block:${state.position.dimension ?? 0}:${cell.x}:${cell.y}:${cell.z}:${cell.code}`,
      code: cell.code,
      point,
      source: current && range <= 8 ? 'surroundings' : 'memory',
      seenAt: cell.seenAt,
      visible: current && range <= 8,
      withinPickingRange: current && range <= (state.pickingRange ?? 4.5) - 0.25,
    });
  }
  return objects;
}
