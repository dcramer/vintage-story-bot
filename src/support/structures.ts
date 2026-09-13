// Blueprint presets from docs/getting-started.md; cells are absolute, in placement order.
const gable = [2, 2, 3, 4, 3, 2, 2];

// origin: floor-level corner cell (blocks sit on ground top y = origin.y); long axis 10 along x, short axis 7 along z.
export function house(origin, item) {
  const at = (dx, dy, dz) => ({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz, item });
  const cells = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 0; dx < 10; dx++) for (const dz of [0, 6]) if (!(dz === 6 && dx === 4)) cells.push(at(dx, dy, dz));
    for (let dz = 1; dz < 6; dz++) for (const dx of [0, 9]) cells.push(at(dx, dy, dz));
  }
  for (const dx of [0, 9]) for (let dz = 0; dz < 7; dz++) for (let dy = 2; dy < gable[dz]; dy++) cells.push(at(dx, dy, dz));
  for (let dz = 0; dz < 7; dz++) for (let dx = 1; dx < 9; dx++) cells.push(at(dx, gable[dz], dz));
  return cells;
}

// origin: the dug pit cell; plus of blocks on the ground surface around the pit (corners open).
export function pitKiln(origin, item) {
  return [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ].map(([dx, dz]) => ({ x: origin.x + dx, y: origin.y + 1, z: origin.z + dz, item }));
}

export const SHELTER_SIZE = 5;
export const SHELTER_MATERIAL = 'game:rammed-light-plain';
// Starter template: 5x5 outside, 3x3 inside, walls two high and a sealed flat roof.
// origin is the floor-level corner; the door gap is 1 wide and 2 high in the middle of the +z wall.
export function shelter(origin, item) {
  const cells = [];
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < SHELTER_SIZE; dx++)
      for (let dz = 0; dz < SHELTER_SIZE; dz++) {
        if (dx !== 0 && dx !== 4 && dz !== 0 && dz !== 4) continue;
        if (dz === 4 && dx === 2) continue;
        cells.push({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz, item });
      }
  for (let dx = 0; dx < SHELTER_SIZE; dx++)
    for (let dz = 0; dz < SHELTER_SIZE; dz++) cells.push({ x: origin.x + dx, y: origin.y + 2, z: origin.z + dz, item });
  return cells;
}
export const shelterDoor = (origin, item) => [0, 1].map(dy => ({ x: origin.x + 2, y: origin.y + dy, z: origin.z + 4, item }));
export const shelterCenter = origin => ({ x: origin.x + 2.5, z: origin.z + 2.5 });
export const shelterTorches = origin => [{ x: origin.x + 2, y: origin.y, z: origin.z + 1 }];
export const shelterStorage = origin => [1, 2, 3].flatMap(z => [1, 3].map(x => ({ x: origin.x + x, y: origin.y, z: origin.z + z })));

export const presets = { house, pit_kiln: pitKiln, shelter };

export function box(from, to) {
  const cells = [];
  const [x0, x1] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
  const [y0, y1] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
  const [z0, z1] = [Math.min(from.z, to.z), Math.max(from.z, to.z)];
  for (let y = y1; y >= y0; y--) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cells.push({ x, y, z });
  return cells;
}
