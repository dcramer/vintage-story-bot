import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerrainMemory } from '../src/runtime/navigation/terrain.ts';
import { pitLimit, reachable, stairStep } from '../src/support/digging.ts';

// A block world: floor at y=-1, air above, plus solid cells from `solid`.
function world(width, solid) {
  const map = new TerrainMemory(),
    cells = [];
  for (let x = -width; x <= width; x++)
    for (let z = -width; z <= width; z++)
      for (let y = -3; y <= 6; y++) cells.push([x, y, z, 0, null, y === -1 || solid(x, y, z) ? [[0, 0, 0, 1, 1, 1]] : []]);
  map.apply({ session: 'w', reset: true, cursor: 1, more: false, clock: 0, cells });
  return map;
}

test('a pit is a place the search runs out of; open ground is not', () => {
  const pit = world(6, (x, y, z) => (Math.abs(x) >= 1 || Math.abs(z) >= 1) && y >= 0 && y <= 3);
  assert.equal(reachable(pit, { x: 0.5, y: 0, z: 0.5 }), 1);
  assert.equal(
    reachable(
      world(6, () => false),
      { x: 0.5, y: 0, z: 0.5 },
    ),
    pitLimit,
  );
});

test('the stair step goes through the wall toward the goal and lists the blocks to cut', () => {
  const pit = world(6, (x, y, z) => (Math.abs(x) >= 1 || Math.abs(z) >= 1) && y >= 0 && y <= 3);
  const plan = stairStep(pit, { x: 0.5, y: 0, z: 0.5 }, { x: 5, y: 0, z: 0.5 });
  assert.deepEqual(plan.step, { x: 1, y: 0, z: 0 });
  assert.deepEqual(
    plan.dig.map(c => c.y),
    [1, 2, 3],
  );
  // After cutting, the step is an ordinary jump up for the grid.
  for (const cell of plan.dig)
    pit.apply({ session: 'w', reset: false, cursor: 2, more: false, clock: 0, cells: [[cell.x, cell.y, cell.z, 0, null, []]] });
  assert.ok(pit.moves({ x: 0.5, y: 0, z: 0.5 }).some(m => m.node.move === 'jump' && Math.floor(m.node.x) === 1));
});

test('a stair may be planned through a wall that occludes its foot block', () => {
  const pit = world(3, (x, y, z) => (Math.abs(x) >= 1 || Math.abs(z) >= 1) && y >= 0 && y <= 3);
  pit.forget('1,0,0');
  assert.deepEqual(stairStep(pit, { x: 0.5, y: 0, z: 0.5 }, { x: 5, y: 0, z: 0.5 })?.step, { x: 1, y: 0, z: 0 });

  pit.apply({ session: 'w', reset: false, cursor: 2, more: false, clock: 0, cells: [[1, 0, 0, 0, null, []]] });
  assert.notDeepEqual(stairStep(pit, { x: 0.5, y: 0, z: 0.5 }, { x: 5, y: 0, z: 0.5 })?.step, { x: 1, y: 0, z: 0 });
});

test('water cells over solid ground are waded, deeper water only swum when allowed', () => {
  const pond = new TerrainMemory(),
    cells = [];
  for (let x = -3; x <= 3; x++)
    for (let z = -3; z <= 3; z++)
      for (let y = -4; y <= 4; y++) {
        const water = x >= 1 && y >= -1 && y <= (x === 1 ? -1 : 0);
        cells.push([x, y, z, 0, water ? 'water' : null, y === -2 || (y === -1 && x <= 0) ? [[0, 0, 0, 1, 1, 1]] : []]);
      }
  pond.apply({ session: 'w', reset: true, cursor: 1, more: false, clock: 0, cells });
  const bank = pond.moves({ x: 0.5, y: 0, z: 0.5 });
  const wade = bank.find(m => Math.floor(m.node.x) === 1 && Math.floor(m.node.z) === 0);
  assert.equal(wade?.node.move, 'wade');
  assert.equal(wade.node.y, -1);
  assert.equal(pond.moves({ x: 1.5, y: -1, z: 0.5 }).find(m => Math.floor(m.node.x) === 2)?.node.move, 'swim', 'deeper water is swum');
  pond.swim = false;
  assert.equal(
    pond.moves({ x: 1.5, y: -1, z: 0.5 }).some(m => Math.floor(m.node.x) === 2),
    false,
    'unless a route forbids swimming',
  );
});

test('a burrow site is a standable cell beside two blocks of plain earth two deep, closed all round', async () => {
  const { burrowSite, dugInState } = await import('../src/goals/burrow.ts');
  const hill = world(6, (x, y) => x >= 1 && y >= 0 && y <= 3);
  const site = burrowSite(hill, { x: 0.5, y: 0, z: 0.5 }, 3);
  assert.deepEqual(
    [site.mouth, site.back],
    [
      { x: 1, y: 0, z: 0 },
      { x: 2, y: 0, z: 0 },
    ],
  );
  assert.equal(site.cut.length, 4);
  const thin = world(6, (x, y) => x === 1 && y >= 0 && y <= 3);
  assert.equal(burrowSite(thin, { x: 0.5, y: 0, z: 0.5 }, 3), null, 'a one-block wall makes no pocket');

  const shaft = world(3, (x, y, z) => (Math.abs(x) >= 1 || Math.abs(z) >= 1) && y >= 0 && y <= 3);
  assert.equal(dugInState(shaft, 0, 0, 0), 'open');
  shaft.apply({ session: 'w', reset: false, cursor: 2, more: false, clock: 0, cells: [[0, 2, 0, 0, null, [[0, 0, 0, 1, 1, 1]]]] });
  assert.equal(dugInState(shaft, 0, 0, 0), 'sealed', 'a restarted controller recognizes the block sealing its shelter');
});
