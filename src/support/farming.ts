import { horizontal } from '../runtime/navigation/terrain.ts';
import { supportedFloor, surfaceCover } from './sites.ts';

export type Farm = { origin: { x: number; y: number; z: number }; turn: number };
export const fertileBed = code => /^game:(soil-(medium|high|compost)-|farmland-(dry|moist)-(medium|high|compost)$)/.test(code ?? '');
// Local +z points away from the shoreline; origin.y is the walking surface.
export function farmCell(farm: Farm, x: number, z: number, dy = 0) {
  for (let n = 0; n < farm.turn; n++) [x, z] = [-z, x];
  return { x: farm.origin.x + x, y: farm.origin.y + dy, z: farm.origin.z + z };
}
export const farmBeds = (farm: Farm) => [1, 2, 3, 4].flatMap(x => [1, 2].map(z => ({ ...farmCell(farm, x, z, -1), bed: x - 1 })));
export const farmGate = (farm: Farm) => farmCell(farm, 2, 3);
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
// Lake ice is observed frozen freshwater: it can site winter preparation and
// becomes the same irrigation row when it thaws. Saltwater remains excluded.
export const freshwater = block => /^game:(?:water-|lakeice$)/.test(block?.code ?? '');
export const farmWatered = (map, farm: Farm) =>
  [1, 2, 3, 4].every(x => {
    const p = farmCell(farm, x, -1, -1);
    return freshwater(map?.get(p.x, p.y, p.z));
  });

// New plots use observed level shoreline, not hidden water or assumed air.
export function farmSite(map, home, radius = 64): Farm | null {
  if (!map?.cells) return null;
  const sources = [...map.cells.values()].filter((b: any) => freshwater(b) && horizontal(b, home) <= radius) as any[];
  sources.sort((a, b) => horizontal(a, home) - horizontal(b, home));
  for (const water of sources)
    for (let turn = 0; turn < 4; turn++) {
      const offset = farmCell({ origin: { x: 0, y: 0, z: 0 }, turn }, 1, -1);
      const farm = { origin: { x: water.x - offset.x, y: water.y + 1, z: water.z - offset.z }, turn };
      if (!farmWatered(map, farm)) continue;
      let clear = true;
      for (let x = 0; x < 6 && clear; x++)
        for (let z = 0; z < 4 && clear; z++) {
          const p = farmCell(farm, x, z);
          const floor = map.get(p.x, p.y - 1, p.z);
          if (!/^game:soil-/.test(floor?.code ?? '') || !supportedFloor(floor, p.y)) clear = false;
        }
      if (!clear) continue;
      for (const p of farmMargin(farm))
        for (let h = 0; h < 2; h++) {
          const b = map.get(p.x, p.y + h, p.z);
          if (!b || b.hazard || ((b.boxes.length || (b.code && b.code !== 'game:air')) && !(h === 0 && surfaceCover(b)))) clear = false;
        }
      const approach = farmApproach(farm);
      if (clear && map.nodeAt(Math.floor(approach.x), Math.floor(approach.z), approach.y, 0.1, 0.1)) return farm;
    }
  return null;
}
