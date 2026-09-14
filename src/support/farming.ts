import { horizontal } from '../runtime/navigation/terrain.ts';
import { replaceablePlant } from './blocks.ts';
import { supportedFloor, surfaceCover } from './sites.ts';
import { has } from './traits.ts';

export type Farm = { origin: { x: number; y: number; z: number }; turn: number };
export type FarmGroundwork = { clear: { x: number; y: number; z: number }[]; fill: { x: number; y: number; z: number }[] };
export const fertileBed = code => /^game:(soil-(medium|high|compost)-|farmland-(dry|moist)-(medium|high|compost)$)/.test(code ?? '');
// Local +z points away from the shoreline; origin.y is the walking surface.
export function farmCell(farm: Farm, x: number, z: number, dy = 0) {
  for (let n = 0; n < farm.turn; n++) [x, z] = [-z, x];
  return { x: farm.origin.x + x, y: farm.origin.y + dy, z: farm.origin.z + z };
}
export const farmBeds = (farm: Farm) => [1, 2, 3, 4].flatMap(x => [1, 2].map(z => ({ ...farmCell(farm, x, z, -1), bed: x - 1 })));
export const farmGate = (farm: Farm) => farmCell(farm, 2, 3);
export const farmGateAxis = (farm: Farm): 'n' | 'w' => (farm.turn % 2 ? 'w' : 'n');
export const farmApproach = (farm: Farm) => {
  const p = farmCell(farm, 2, 4);
  return { x: p.x + 0.5, y: p.y, z: p.z + 0.5 };
};
export const farmFence = (farm: Farm) => {
  const cells = [];
  for (let x = 0; x < 6; x++)
    for (let z = 0; z < 4; z++) if ((x === 0 || x === 5 || z === 0 || z === 3) && !(x === 2 && z === 3)) cells.push(farmCell(farm, x, z));
  return cells;
};
export const farmMargin = (farm: Farm) => {
  const cells = [];
  for (let x = -2; x < 8; x++) for (let z = -2; z < 6; z++) cells.push(farmCell(farm, x, z));
  return cells;
};
// The farm replaces its eight beds with fertile soil, so a naturally level
// shovel-workable shore is enough. Requiring fertile soil here strands the
// planner on common sand and gravel shores that it can terraform itself.
export const workableFarmFloor = (cell, y) =>
  !!cell &&
  !cell.hazard &&
  (fertileBed(cell.code) || (supportedFloor(cell, y) && /^game:(?:soil-|forestfloor-|sand-|gravel-)/.test(cell.code ?? '')));
// Lake ice is observed frozen freshwater: it can site winter preparation and
// becomes the same irrigation source when it thaws. Saltwater remains excluded.
export const freshwater = block => /^game:(?:water-|lakeice$)/.test(block?.code ?? '');
export const farmWatered = (map, farm: Farm) =>
  farmBeds(farm).every(bed => {
    // Vintage Story irrigates horizontally within three blocks, including
    // diagonals. One well-placed source can therefore water this 4x2 bed set;
    // demanding a perfectly straight four-block shoreline rejects ordinary
    // ponds and jagged lake edges for no gameplay reason.
    for (let dx = -3; dx <= 3; dx++) for (let dz = -3; dz <= 3; dz++) if (freshwater(map?.get(bed.x + dx, bed.y, bed.z + dz))) return true;
    return false;
  });

const empty = cell => !!cell && !cell.hazard && !cell.boxes.length && (!cell.code || cell.code === 'game:air');
const clearable = cell =>
  !!cell &&
  !cell.hazard &&
  !has(cell, 'container') &&
  (surfaceCover(cell) ||
    replaceablePlant(cell.code) ||
    has(cell, 'diggable') ||
    has(cell, 'choppable') ||
    has(cell, 'leaves') ||
    /^game:(?:aquatic-|flower-|fern-|forestfloor-|gravel-|leaves-|log-|sand-|snow|soil-|tallgrass-|wildvine-)/.test(cell.code ?? ''));

const key = p => `${p.x}:${p.y}:${p.z}`;
const sides = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

// Grade a small farm rather than waiting for a naturally perfect pad. The
// fill order grows from observed permanent ground so generic block placement
// always has a real side support; unknown, player-made and hazardous cells
// still reject the site.
function assessFarmGroundwork(map, farm: Farm, { allowUnknownClearance = false } = {}): FarmGroundwork | null {
  if (!map || !farmWatered(map, farm)) return null;
  const wood = (farm as Farm & { wood?: unknown }).wood;
  const enclosureWood = typeof wood === 'string' ? wood : null;
  const fenceKeys = new Set(farmFence(farm).map(key));
  const gate = farmGate(farm);
  const gateKey = key(gate);
  const establishedGate = !!enclosureWood && map.get(gate.x, gate.y, gate.z)?.code?.startsWith(`game:roughhewnfencegate-${enclosureWood}-`);
  const establishedEnclosure = (at, cell) => {
    if (!enclosureWood || at.y !== farm.origin.y || !cell?.code) return false;
    if (key(at) === gateKey) return cell.code.startsWith(`game:roughhewnfencegate-${enclosureWood}-`);
    return fenceKeys.has(key(at)) && cell.code.startsWith(`game:roughhewnfence-${enclosureWood}-`);
  };
  const footprint = [];
  for (let x = 0; x < 6; x++) for (let z = 0; z < 4; z++) footprint.push(farmCell(farm, x, z, -1));
  const footprintKeys = new Set(footprint.map(key));
  const clear = new Map<string, { x: number; y: number; z: number }>();
  const pending = new Map<string, { x: number; y: number; z: number }>();
  const reached = new Set<string>();

  for (const floor of footprint) {
    const cell = map.get(floor.x, floor.y, floor.z);
    if (workableFarmFloor(cell, floor.y + 1)) {
      reached.add(key(floor));
      continue;
    }
    if (!cell || (!empty(cell) && !freshwater(cell) && !clearable(cell))) return null;
    pending.set(key(floor), floor);
    // Water and air are directly replaceable by a placed soil block. Solid
    // seasonal ice and vegetation must first be removed.
    if (!empty(cell) && (!freshwater(cell) || cell.boxes.length)) clear.set(key(floor), floor);
  }

  // A fill course may also start from permanent ground immediately outside
  // the footprint, then advance across shallow water one supported cell at a time.
  for (const floor of footprint)
    for (const [dx, dz] of sides) {
      const neighbor = { x: floor.x + dx, y: floor.y, z: floor.z + dz };
      if (!footprintKeys.has(key(neighbor)) && workableFarmFloor(map.get(neighbor.x, neighbor.y, neighbor.z), neighbor.y + 1))
        reached.add(key(neighbor));
    }

  const fill: { x: number; y: number; z: number }[] = [];
  while (pending.size) {
    const candidates = [...pending.values()].filter(cell =>
      sides.some(([dx, dz]) => reached.has(key({ x: cell.x + dx, y: cell.y, z: cell.z + dz }))),
    );
    // A cell over an observed solid bed can be placed straight down from dry
    // ground. Build those before extending sideways over deeper water, so the
    // side placements have a wider, reachable platform to work from.
    candidates.sort((a, b) => Number(supportedFloor(map.get(b.x, b.y - 1, b.z), b.y)) - Number(supportedFloor(map.get(a.x, a.y - 1, a.z), a.y)));
    const next = candidates[0];
    if (!next) return null;
    pending.delete(key(next));
    reached.add(key(next));
    fill.push(next);
  }

  // Clear two blocks of headroom across the animal-proof margin. One-block
  // natural rises are grading work; liquids, structures and unseen cells are
  // not silently assumed away.
  for (const p of farmMargin(farm))
    for (let h = 0; h < 2; h++) {
      const at = { ...p, y: p.y + h };
      const cell = map.get(at.x, at.y, at.z);
      if (!cell && allowUnknownClearance) continue;
      if (empty(cell)) continue;
      // Once the gate exists, the farm goal opens it before clearing seasonal
      // cover from inside. Sending generic groundwork after snow inside an
      // enclosure can only aim through the fence that blocks it.
      if (establishedGate && surfaceCover(cell)) continue;
      // Revalidating a persisted plan happens after construction may already
      // have placed part or all of its enclosure. Those exact, planned blocks
      // are proof of durable progress, not foreign structures that invalidate
      // the shoreline. New site discovery has no wood on its candidate and
      // therefore remains strict around every player-made block.
      if (establishedEnclosure(at, cell)) continue;
      if (!clearable(cell)) return null;
      clear.set(key(at), at);
    }
  return { clear: [...clear.values()].sort((a, b) => a.y - b.y || a.x - b.x || a.z - b.z), fill };
}

export function farmGroundwork(map, farm: Farm): FarmGroundwork | null {
  return assessFarmGroundwork(map, farm);
}

// A promising shoreline whose foundation and irrigation are known, but whose
// whole animal-proof margin has not yet been seen from close range. The brain
// may walk near it and take a panorama; construction still uses the strict
// farmGroundwork result above.
export function farmSurveyGroundwork(map, farm: Farm): FarmGroundwork | null {
  return assessFarmGroundwork(map, farm, { allowUnknownClearance: true });
}

export function farmSurveyClearing(map, farm: Farm) {
  return farmSurveyGroundwork(map, farm)?.clear ?? [];
}

function chooseFarmSite(map, home, radius: number, survey: boolean, accept: (farm: Farm) => boolean): Farm | null {
  if (!map?.cells) return null;
  const sources = [...map.cells.values()].filter((b: any) => freshwater(b) && horizontal(b, home) <= radius) as any[];
  sources.sort((a, b) => horizontal(a, home) - horizontal(b, home));
  let best: { farm: Farm; score: number } | null = null;
  for (const water of sources)
    for (let turn = 0; turn < 4; turn++) {
      const offset = farmCell({ origin: { x: 0, y: 0, z: 0 }, turn }, 1, -1);
      const farm = { origin: { x: water.x - offset.x, y: water.y + 1, z: water.z - offset.z }, turn };
      if (!accept(farm)) continue;
      const work = survey ? farmSurveyGroundwork(map, farm) : farmGroundwork(map, farm);
      if (!work) continue;
      const approach = farmApproach(farm);
      if (!survey && !map.nodeAt(Math.floor(approach.x), Math.floor(approach.z), approach.y, 0.1, 0.1)) continue;
      const score = work.fill.length * 2 + work.clear.length + horizontal(farm.origin, home) / 16;
      if (!best || score < best.score) best = { farm, score };
    }
  return best?.farm ?? null;
}

// New plots use observed freshwater and a gradeable permanent shoreline, not
// hidden water, seasonal footing or assumed air.
export function farmSite(map, home, radius = 64, accept: (farm: Farm) => boolean = () => true): Farm | null {
  return chooseFarmSite(map, home, radius, false, accept);
}

export function farmSurveySite(map, home, radius = 64, accept: (farm: Farm) => boolean = () => true): Farm | null {
  return chooseFarmSite(map, home, radius, true, accept);
}
