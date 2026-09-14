import { shelterCover, supportedFloor } from './sites.ts';
import { has } from './traits.ts';

export type HouseCell = { x: number; y: number; z: number };
export type HouseGroundwork = { clear: HouseCell[]; fill: HouseCell[] };

const empty = cell => !!cell && !cell.hazard && cell.boxes.length === 0 && (!cell.code || cell.code === 'game:air');
const natural = cell =>
  has(cell, 'diggable') ||
  has(cell, 'choppable') ||
  !!cell?.traits?.includes('leaves') ||
  /^game:(?:soil-|forestfloor-|sand-|gravel-|log-|leaves-|snow)/.test(cell?.code ?? '');

const floorCells = (origin: HouseCell) => {
  const cells: HouseCell[] = [];
  for (let x = 0; x < 10; x++) for (let z = 0; z < 7; z++) cells.push({ x: origin.x + x, y: origin.y - 1, z: origin.z + z });
  // The two ground-level approach steps also need permanent footing.
  cells.push({ x: origin.x + 3, y: origin.y - 1, z: origin.z + 7 });
  cells.push({ x: origin.x + 3, y: origin.y - 1, z: origin.z + 8 });
  cells.push({ x: origin.x + 4, y: origin.y - 1, z: origin.z + 7 });
  cells.push({ x: origin.x + 4, y: origin.y - 1, z: origin.z + 8 });
  return cells;
};

// A planned house may stand on existing permanent ground or bridge a one-block
// dip with ordinary earth. Anything deeper, unknown or seasonal is rejected.
// Natural material occupying the build volume is explicit clearing work;
// containers, ruins and other player-made blocks disqualify the footprint.
export function houseGroundwork(terrain: any, origin: HouseCell): HouseGroundwork | null {
  if (!terrain) return null;
  const fill: HouseCell[] = [];
  for (const floor of floorCells(origin)) {
    const base = terrain.get(floor.x, floor.y, floor.z);
    if (supportedFloor(base, origin.y)) continue;
    const below = terrain.get(floor.x, floor.y - 1, floor.z);
    if (!empty(base) || !supportedFloor(below, origin.y - 1)) return null;
    fill.push(floor);
  }

  const clear: HouseCell[] = [];
  for (let x = 0; x < 10; x++)
    for (let z = 0; z < 7; z++)
      for (let h = 0; h <= 4; h++) {
        const cell = { x: origin.x + x, y: origin.y + h, z: origin.z + z };
        const seen = terrain.get(cell.x, cell.y, cell.z);
        if (empty(seen)) continue;
        if (!seen || seen.hazard || !(shelterCover(seen, h) || natural(seen))) return null;
        clear.push(cell);
      }
  for (const cell of [
    { x: origin.x + 3, y: origin.y, z: origin.z + 7 },
    { x: origin.x + 3, y: origin.y, z: origin.z + 8 },
    { x: origin.x + 3, y: origin.y + 1, z: origin.z + 7 },
    { x: origin.x + 4, y: origin.y, z: origin.z + 7 },
    { x: origin.x + 4, y: origin.y, z: origin.z + 8 },
  ]) {
    const seen = terrain.get(cell.x, cell.y, cell.z);
    if (empty(seen)) continue;
    if (!seen || seen.hazard || !(shelterCover(seen, cell.y - origin.y) || natural(seen))) return null;
    clear.push(cell);
  }
  return { clear, fill };
}

export function houseFoundationSafe(terrain: any, origin: HouseCell): boolean {
  return !!terrain && floorCells(origin).every(cell => supportedFloor(terrain.get(cell.x, cell.y, cell.z), origin.y));
}
