import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const schema = z.object({
  x: z.number().finite().optional(),
  z: z.number().finite().optional(),
  radius: z.number().int().min(1).max(32).default(16),
}).strict();

const columnKey = (x, z) => `${x},${z}`;

// What the bot has seen of the ground: nearby observed collision geometry
// reduced to standing surfaces, plus distant columns from the vision feed. Columns the
// bot never saw are absent, never guessed.
export function terrainView(map, surface, center, radius, now = Date.now()) {
  const columns = new Map();
  for (const cell of map.cells.values()) {
    if (Math.abs(cell.x - center.x) > radius || Math.abs(cell.z - center.z) > radius || Math.abs(cell.y - center.y) > 8) continue;
    const top = cell.boxes.length ? Math.max(...cell.boxes.map(b => b[4])) : null;
    const id = columnKey(cell.x, cell.z), prior = columns.get(id);
    if (cell.hazard) { if (!prior || prior.kind !== 'hazard' || prior.y < cell.y + 1) columns.set(id, { x: cell.x, z: cell.z, y: cell.y + 1, kind: 'hazard', source: 'observed', at: cell.at }); continue; }
    if (top === null || prior?.kind === 'hazard' && prior.y >= top) continue;
    if (!prior || prior.y < top) columns.set(id, { x: cell.x, z: cell.z, y: top, kind: 'ground', source: 'observed', at: cell.at });
  }
  for (const column of surface.columns.values()) {
    if (Math.abs(column.x - center.x) > radius || Math.abs(column.z - center.z) > radius) continue;
    const id = columnKey(column.x, column.z);
    if (!columns.has(id)) columns.set(id, { ...column, source: 'seen' });
  }
  const rows = [...columns.values()].sort((a, b) => Math.hypot(a.x + .5 - center.x, a.z + .5 - center.z) - Math.hypot(b.x + .5 - center.x, b.z + .5 - center.z));
  const counts = {};
  for (const row of rows) counts[row.kind] = (counts[row.kind] ?? 0) + 1;
  return { ok: true, center: { x: center.x, z: center.z }, radius, known: rows.length,
    unknown: (2 * radius + 1) ** 2 - rows.length, counts,
    // Both memories stamp rows with the mod's monotonic clock, never wall time.
    columns: rows.map(row => [row.x, row.z, +row.y.toFixed(3), row.kind, row.source, Math.max(0, (row.source === 'observed' ? map.now : surface.now) - row.at)]) };
}

export default defineAction({
  name: 'terrain',
  schema,
  readOnly: true,
  description:
    'Ground the bot has seen around a point (default: own position), radius ≤32. Rows [x,z,y,kind,source,ageMs]: y is the ' +
    'highest known standing surface, kind ground|canopy|water|hazard, source observed (nearby collision geometry, exact) or ' +
    'seen (distant sight sample streamed as the camera moves, coarser with distance). Absent columns are unknown, never air: ' +
    'look toward them to learn them. Memory only; expires with movement and time.',
  local: async (runtime, { x, z, radius }) => {
    // Drain pending perception deltas first so look-then-terrain reflects the
    // current view; own position anchors the vertical window of the geometry.
    const state = await runtime.snapshot();
    const center = { x: Math.floor(x ?? state.position.x), z: Math.floor(z ?? state.position.z), y: state.position.y };
    return terrainView(runtime.map, runtime.surface, center, radius);
  },
});
