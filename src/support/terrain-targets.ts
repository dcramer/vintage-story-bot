import { distance } from '../runtime/navigation/terrain.ts';

// Bulk blocks are terrain, not sightings. Goals may target only recently observed
// surrounding cells; native selection and permissions are still checked before acting.
export function terrainTargets(field, matches: string[]) {
  const state = field.latest;
  const eye = { ...state.position, y: state.position.y + (state.body?.eyeHeight ?? 1.6) };
  const now = field.now();
  const objects = [];
  for (const cell of field.env.map?.cells.values() ?? []) {
    if (!cell.code || cell.hazard || !Number.isFinite(cell.seenAt) || now - cell.seenAt > 5000 || !matches.some(match => cell.code.includes(match)))
      continue;
    const point = { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 };
    const range = distance(eye, point);
    if (range > 8) continue;
    objects.push({
      kind: 'block',
      key: `block:${state.position.dimension ?? 0}:${cell.x}:${cell.y}:${cell.z}:${cell.code}`,
      code: cell.code,
      point,
      source: 'surroundings',
      seenAt: cell.seenAt,
      withinPickingRange: range <= (state.pickingRange ?? 4.5) - 0.25,
    });
  }
  return objects;
}
