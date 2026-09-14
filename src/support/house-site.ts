import { replaceablePlant } from './blocks.ts';
import { pickupBlock } from './gleaning.ts';
import { shelterCover, supportedFloor } from './sites.ts';
import { has } from './traits.ts';

export type HouseCell = { x: number; y: number; z: number };
export type HouseGroundwork = { clear: HouseCell[]; fill: HouseCell[] };

const empty = cell => !!cell && !cell.hazard && cell.boxes.length === 0 && (!cell.code || cell.code === 'game:air');
const loose = cell => pickupBlock({ ...cell, kind: 'block' });
const natural = cell =>
  has(cell, 'diggable') ||
  has(cell, 'choppable') ||
  !!cell?.traits?.includes('leaves') ||
  /^game:(?:soil-|forestfloor-|sand-|gravel-|log-|leaves-|snow)/.test(cell?.code ?? '');
const seasonal = cell => has(cell, 'liquid') || /(?:^|:)lakeice$/.test(cell?.code ?? '');
const permanentFloor = (cell, y) =>
  supportedFloor(cell, y) && !has(cell, 'choppable') && !has(cell, 'leaves') && !/^game:snow/.test(cell?.code ?? '');
const removable = cell =>
  !!cell &&
  !cell.hazard &&
  !seasonal(cell) &&
  !has(cell, 'container') &&
  (empty(cell) || loose(cell) || replaceablePlant(cell.code) || natural(cell));

const MAX_FILL_DEPTH = 2;

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

// A planned house may stand on existing permanent ground or bridge a shallow
// dip with ordinary earth. Surface plants, snow and tree trunks are removed
// first; fill is returned bottom-up so every placement has support. Anything
// deeper, unknown, player-made, liquid or seasonal is rejected.
// Natural material occupying the build volume is explicit clearing work;
// containers, ruins and other player-made blocks disqualify the footprint.
function assessGroundwork(
  terrain: any,
  origin: HouseCell,
  { allowUnknownClearance = false, allowUnknownFoundation = false } = {},
): HouseGroundwork | null {
  if (!terrain) return null;
  const fill: HouseCell[] = [];
  const clear: HouseCell[] = [];
  const floors = floorCells(origin);
  let groundEvidence = 0;
  for (const floor of floors) {
    const column: HouseCell[] = [];
    let supported = false;
    for (let depth = 0; depth <= MAX_FILL_DEPTH; depth++) {
      const cell = { ...floor, y: floor.y - depth };
      const seen = terrain.get(cell.x, cell.y, cell.z);
      if (!seen && allowUnknownFoundation) {
        supported = true;
        break;
      }
      if (depth === 0 && seen) groundEvidence++;
      if (permanentFloor(seen, cell.y + 1)) {
        supported = true;
        break;
      }
      if (!removable(seen)) return null;
      if (!empty(seen) && !loose(seen)) clear.push(cell);
      column.push(cell);
    }
    if (!supported) return null;
    fill.push(...column.reverse());
  }
  if (allowUnknownFoundation && groundEvidence < Math.ceil(floors.length / 2)) return null;

  for (let x = 0; x < 10; x++)
    for (let z = 0; z < 7; z++)
      for (let h = 0; h <= 4; h++) {
        const cell = { x: origin.x + x, y: origin.y + h, z: origin.z + z };
        const seen = terrain.get(cell.x, cell.y, cell.z);
        if (!seen && allowUnknownClearance) continue;
        if (empty(seen) || loose(seen)) continue;
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
    if (!seen && allowUnknownClearance) continue;
    if (empty(seen) || loose(seen)) continue;
    if (!seen || seen.hazard || !(shelterCover(seen, cell.y - origin.y) || natural(seen))) return null;
    clear.push(cell);
  }
  return { clear, fill };
}

export function houseGroundwork(terrain: any, origin: HouseCell): HouseGroundwork | null {
  return assessGroundwork(terrain, origin);
}

// A foundation whose actual ground is fully known but whose upper volume has
// not been seen from close range yet. The brain may travel to its center and
// look around, but construction still requires strict houseGroundwork.
export function houseSurveyGroundwork(terrain: any, origin: HouseCell): HouseGroundwork | null {
  return assessGroundwork(terrain, origin, { allowUnknownClearance: true, allowUnknownFoundation: true });
}

// Surface-only work that can safely reveal a surveyed foundation. It never
// guesses at soil, stone or unknown cells: only vegetation, snow and wood the
// client has actually observed are returned.
export function houseSurveyClearing(terrain: any, origin: HouseCell): HouseCell[] {
  if (!terrain) return [];
  const cells: HouseCell[] = [];
  for (let x = 0; x < 10; x++)
    for (let z = 0; z < 7; z++) for (let y = origin.y - 1; y <= origin.y + 4; y++) cells.push({ x: origin.x + x, y, z: origin.z + z });
  for (const floor of floorCells(origin)) for (let y = floor.y; y <= origin.y + 1; y++) cells.push({ ...floor, y });
  const unique = new Map(cells.map(cell => [`${cell.x}:${cell.y}:${cell.z}`, cell]));
  return [...unique.values()].filter(cell => {
    const seen = terrain.get(cell.x, cell.y, cell.z);
    return (
      !!seen &&
      !seen.hazard &&
      !seasonal(seen) &&
      !has(seen, 'container') &&
      (shelterCover(seen, 0) || replaceablePlant(seen.code) || has(seen, 'choppable') || has(seen, 'leaves'))
    );
  });
}

export function houseFoundationSafe(terrain: any, origin: HouseCell): boolean {
  return !!terrain && floorCells(origin).every(cell => permanentFloor(terrain.get(cell.x, cell.y, cell.z), origin.y));
}
