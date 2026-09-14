// Blueprint presets from docs/getting-started.md; cells are absolute, in placement order.
const gable = [2, 2, 3, 4, 3, 2, 2];

// origin: floor-level corner cell (blocks sit on ground top y = origin.y); long axis 10 along x, short axis 7 along z.
export function house(origin, item) {
  const at = (dx, dy, dz) => ({ x: origin.x + dx, y: origin.y + dy, z: origin.z + dz, item });
  const cells = [];
  for (let dy = 0; dy < 2; dy++) {
    for (let dx = 3; dx >= 0; dx--) cells.push(at(dx, dy, 6));
    for (let dz = 5; dz >= 0; dz--) cells.push(at(0, dy, dz));
    for (let dx = 1; dx < 10; dx++) cells.push(at(dx, dy, 0));
    for (let dz = 1; dz <= 6; dz++) cells.push(at(9, dy, dz));
    for (let dx = 8; dx >= 5; dx--) cells.push(at(dx, dy, 6));
  }
  for (const dx of [0, 9]) for (let dy = 2; dy <= 4; dy++) for (let dz = 0; dz < 7; dz++) if (dy <= gable[dz]) cells.push(at(dx, dy, dz));
  // The access stairs meet the +z eave. Lay the roof away from those stairs,
  // one complete course at a time, so every next course is reachable from the
  // roof already underfoot. Starting at the opposite eave makes a partial
  // build strand the player on the stairs with no observed route to its work.
  for (let dz = 6; dz >= 0; dz--) {
    // Start the front eave at the scaffold and bridge the doorway (x+4)
    // only after both neighboring roof blocks exist. If that span is placed
    // while standing on its sole lateral support, the support face is hidden
    // under the player's feet.
    const xs = dz === 6 ? [3, 2, 1, 5, 6, 7, 8, 4] : Array.from({ length: 8 }, (_, i) => ((6 - dz) % 2 === 0 ? i + 1 : 8 - i));
    for (const dx of xs) cells.push(at(dx, gable[dz], dz));
  }
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
// Two rises keep the roof reachable after roofing covers the wall top.
export const shelterScaffold = (origin, item) => [
  { x: origin.x + 1, y: origin.y, z: origin.z + 6, item },
  { x: origin.x + 1, y: origin.y, z: origin.z + 5, item },
  { x: origin.x + 1, y: origin.y + 1, z: origin.z + 5, item },
];
export const shelterCenter = origin => ({ x: origin.x + 2.5, z: origin.z + 2.5 });
export const shelterTorches = origin => [{ x: origin.x + 2, y: origin.y, z: origin.z + 1 }];
export const shelterStorage = origin => [1, 2, 3].flatMap(z => [1, 3].map(x => ({ x: origin.x + x, y: origin.y, z: origin.z + z })));

// The larger house uses the same front-step technique. Its sloped roof then
// remains traversable one course at a time all the way to the ridge.
export const houseScaffold = (origin, item) => [
  { x: origin.x + 3, y: origin.y, z: origin.z + 8, item },
  { x: origin.x + 3, y: origin.y, z: origin.z + 7, item },
  { x: origin.x + 3, y: origin.y + 1, z: origin.z + 7, item },
];

export const presets = { house, pit_kiln: pitKiln, shelter };

export function box(from, to) {
  const cells = [];
  const [x0, x1] = [Math.min(from.x, to.x), Math.max(from.x, to.x)];
  const [y0, y1] = [Math.min(from.y, to.y), Math.max(from.y, to.y)];
  const [z0, z1] = [Math.min(from.z, to.z), Math.max(from.z, to.z)];
  for (let y = y1; y >= y0; y--) for (let x = x0; x <= x1; x++) for (let z = z0; z <= z1; z++) cells.push({ x, y, z });
  return cells;
}
