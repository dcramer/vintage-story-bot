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

// The tiny shelter of docs/brain.md: a one-door box 3 wide by 3 deep, walls 2 high, flat roof.
// origin is the floor-level corner; the door gap is 1 wide and 2 high in the middle of the +z wall.
export function shelter(origin, item) {
  const cells = [];
  for (let dy = 0; dy < 2; dy++)
    for (let dx = 0; dx < 3; dx++)
      for (let dz = 0; dz < 3; dz++) {
        if (dx !== 0 && dx !== 2 && dz !== 0 && dz !== 2) continue;
        if (dz === 2 && dx === 1) continue;
        cells.push({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz, item });
      }
  for (let dx = 0; dx < 3; dx++) for (let dz = 0; dz < 3; dz++) cells.push({ x: origin.x + dx, y: origin.y + 2, z: origin.z + dz, item });
  return cells;
}
export const shelterDoor = (origin, item) => [0, 1].map(dy => ({ x: origin.x + 1, y: origin.y + dy, z: origin.z + 2, item }));
export const shelterCenter = origin => ({ x: origin.x + 1.5, z: origin.z + 1.5 });

export const presets = { house, pit_kiln: pitKiln, shelter };

export function box(from, to) {
  const cells = [];
  const [x0, x1] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
  const [y0, y1] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
  const [z0, z1] = [Math.min(from.z, to.z), Math.max(from.z, to.z)];
  for (let y = y1; y >= y0; y--) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cells.push({ x, y, z });
  return cells;
}
