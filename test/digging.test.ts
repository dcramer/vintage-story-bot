import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TerrainMemory } from '../src/runtime/navigation/terrain.ts';
import { diggingSlot, digOut, pitLimit, reachable, stairStep, supportedSteps } from '../src/support/digging.ts';
import { until } from '../src/support/fieldwork.ts';

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

test('pillar recovery only proposes an empty step attached to observed support with jump clearance', () => {
  const map = world(3, (x, y, z) => (x === 0 && z === 0 && y === 0) || (x === 1 && z === -1 && y === 1));
  const origin = { x: 0.5, y: 1, z: 0.5 },
    toward = { x: 10, z: 0 };
  assert.ok(supportedSteps(map, origin, toward).some(p => p.cell.x === 1 && p.cell.z === 0 && p.face === 'south'));
  map.put({ x: 1, y: 2, z: 0, seenAt: Date.now(), traits: [], boxes: [[1, 2, 0, 2, 3, 1]] });
  assert.ok(
    supportedSteps(map, origin, toward).every(p => p.cell.x !== 1 || p.cell.z !== 0),
    'occupied headroom prevents building that step',
  );
  const unsupported = world(3, (x, y, z) => x === 0 && z === 0 && y === 0);
  assert.deepEqual(supportedSteps(unsupported, origin, toward), [], 'air alone is not placement support');
});

test('pit recovery lands on the observed step when starting on thin snow', async () => {
  const map = world(2, (x, y, z) => (x !== 0 || z !== 0) && y >= 0 && y <= 3);
  map.put({ x: 0, y: 0, z: 0, seenAt: Date.now(), traits: [], boxes: [[0, 0, 0, 1, 0.125, 1]] });
  for (const y of [1, 2, 3]) map.put({ x: 1, y, z: 0, seenAt: Date.now(), traits: [], boxes: [] });
  const field = {
    env: { map },
    latest: { position: { x: 0.5, y: 0.125, z: 0.5 }, motion: { onGround: true } },
    observe: async () => field.latest,
    send: async () => ({ inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: null, quantity: 0 }] }] }),
    report: () => {},
    wait: async () => {
      field.latest.position.y = 1;
      field.latest.motion.onGround = true;
    },
    walk: async destination => {
      assert.equal(destination.y, 1, 'the starting snow height must not carry over to the landing');
      field.latest.position = { x: destination.x, y: destination.y + 0.02, z: destination.z };
      field.latest.motion.onGround = false;
      return { state: 'arrived' };
    },
  };
  const result = await digOut(field, { x: 5, z: 0.5 }, { steps: 1 });
  assert.equal(result.climbed, 1);
});

test('pit recovery explicitly digs a full block occupying the grounded body cell', async () => {
  const map = world(3, (x, y, z) => x === 0 && y === 0 && z === 0);
  const target = 'block:0:0:0:0:game:snowblock';
  const inventory = {
    state: 'inventory-1',
    inventories: [
      {
        name: 'hotbar',
        slots: [{ slot: 0, code: 'game:shovel-flint', quantity: 1, tool: 'Shovel', toolTier: 1, durability: 50 }],
      },
    ],
  };
  let recoveryRequest = null;
  const field = {
    env: { map },
    latest: {
      position: { x: 0.5, y: 0, z: 0.5, dimension: 0 },
      body: { eyeHeight: 1.7 },
      motion: { onGround: true },
      capabilities: ['body_cell_dig'],
      activeSlot: 0,
    },
    observe: async () => field.latest,
    send: async request => {
      if (request.action === 'inventory') return inventory;
      if (request.action === 'select' || request.action === 'aim_cell') return { ok: true };
      if (request.action === 'inspect_target') return { key: target, code: 'game:snowblock', material: 'Snow', requiredMiningTier: 0 };
      if (request.action === 'block_action_begin') {
        recoveryRequest = request;
        map.put({ x: 0, y: 0, z: 0, seenAt: Date.now(), code: 'game:air', traits: [], boxes: [] });
        return { state: 'changed', changedForMs: 1000, position: { x: 0, y: 0, z: 0 }, before: 'game:snowblock', after: 'game:air' };
      }
      throw Error(`Unexpected action: ${request.action}`);
    },
    report: () => {},
    wait: async () => {},
  };
  const result = await digOut(field, { x: 5, z: 0.5 }, { steps: 1 });
  assert.equal(result.ok, true);
  assert.equal(result.climbed, 0);
  assert.equal(recoveryRequest.allowBodyCellDig, true);
});

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

  const shallow = world(
    3,
    (x, y, z) =>
      y === 1 &&
      [
        [1, 0],
        [-1, 0],
        [0, 1],
      ].some(([ax, az]) => x === ax && z === az),
  );
  assert.equal(dugInState(shallow, 0, 0, 0), 'open');
  shallow.apply({ session: 'w', reset: false, cursor: 2, more: false, clock: 0, cells: [[0, 2, 0, 0, null, [[0, 0, 0, 1, 1, 1]]]] });
  assert.equal(dugInState(shallow, 0, 0, 0), 'sealed', 'a shallow rim supporting a seal is still the completed burrow');
});

test('a burrow steps beside surface cover before clearing its own body cell on an older bridge', async () => {
  const { burrow } = await import('../src/goals/burrow.ts');
  const map = world(2, () => false);
  const inventory = {
    state: 'pack',
    inventories: [
      {
        name: 'hotbar',
        slots: [{ slot: 0, code: 'game:shovel-flint', quantity: 1, tool: 'Shovel', toolTier: 1, durability: 50 }],
      },
    ],
  };
  const cover = 'block:0:0:0:0:game:tallgrass-short-snow3';
  const ground = 'block:0:0:-1:0:game:soil-low-none';
  const walks = [],
    begins = [];
  let covered = true;
  const field = {
    env: { map },
    latest: {
      position: { x: 0.5, y: 0.125, z: 0.5, dimension: 0 },
      body: { eyeHeight: 1.7, halfWidth: 0.3 },
      motion: { onGround: true, feetInLiquid: false, swimming: false },
      capabilities: [],
      activeSlot: 0,
    },
    observe: async () => field.latest,
    aim: async () => {},
    approach: (_, exclude) =>
      [
        { x: 1.5, y: 0.125, z: 0.5, arrivalRadius: 0.35 },
        { x: 2.5, y: 0.125, z: 0.5, arrivalRadius: 0.35 },
      ].find(destination => !exclude(destination)),
    walk: async destination => {
      walks.push(destination);
      field.latest.position = {
        ...field.latest.position,
        x: destination.x > 1 ? destination.x - destination.arrivalRadius : destination.x,
        y: destination.y,
        z: destination.z,
      };
      return { state: 'arrived' };
    },
    send: async request => {
      if (request.action === 'inventory') return inventory;
      if (request.action === 'select') {
        field.latest.activeSlot = request.slot;
        return { ok: true };
      }
      if (request.action === 'aim_cell') return { ok: true };
      if (request.action === 'inspect_target')
        return covered
          ? { key: cover, code: 'game:tallgrass-short-snow3', material: 'Plant', requiredMiningTier: 0 }
          : { key: ground, code: 'game:soil-low-none', material: 'Soil', requiredMiningTier: 0 };
      if (request.action === 'block_action_begin') {
        begins.push({ ...request, x: field.latest.position.x });
        if (request.target === cover) {
          covered = false;
          map.put({ x: 0, y: 0, z: 0, seenAt: Date.now(), code: 'game:air', traits: [], boxes: [] });
          return { state: 'changed', changedForMs: 1000, position: { x: 0, y: 0, z: 0 }, before: 'game:tallgrass-short-snow3', after: 'game:air' };
        }
        return { state: 'failed', reason: 'test_stop' };
      }
      throw Error(`Unexpected action: ${request.action}`);
    },
    report: () => {},
    wait: async () => {},
  };

  const result = await burrow(field, null);

  assert.equal(result.reason, 'test_stop');
  assert.equal(begins[0].target, cover);
  assert.equal(begins[0].x, 2.15, 'arrival tolerance still leaves the body clear of the surface cell');
  assert.equal(begins[0].allowBodyCellDig, undefined, 'an older bridge never receives the unsupported escape hatch');
  assert.equal(walks.at(-1).x, 0.5, 'the body returns over the cleared shaft before digging ground');
});

test('a sealed pit clears takeoff headroom before cutting the stair wall', () => {
  const pit = world(4, (x, y, z) => y >= 0 && y <= 3 && (x !== 0 || z !== 0 || y === 2));
  const origin = { x: 0.5, y: 0, z: 0.5 };
  const plan = stairStep(pit, origin, { x: 5, y: 0, z: 0.5 });
  assert.deepEqual(plan.dig[0], { x: 0, y: 2, z: 0 });
  pit.put({ x: 0, y: 2, z: 0, seenAt: Date.now(), traits: ['leaves'], code: 'game:leaves-grown5-birch', boxes: [] });
  assert.deepEqual(
    stairStep(pit, origin, { x: 5, y: 0, z: 0.5 }).dig[0],
    { x: 0, y: 2, z: 0 },
    'non-colliding leaves still obstruct mining the upper wall',
  );
  for (const c of plan.dig) pit.put({ x: c.x, y: c.y, z: c.z, seenAt: Date.now(), traits: [], boxes: [] });
  assert.ok(pit.moves(origin).some(({ node }) => node.x === 1.5 && node.z === 0.5 && node.move === 'jump'));
  pit.put({ x: 0, y: 2, z: 0, seenAt: Date.now(), traits: ['water'], boxes: [] });
  assert.equal(stairStep(pit, origin, { x: 5, y: 0, z: 0.5 }), null, 'do not open an overhead hazard');
});

test('a low ceiling over thin snow needs headroom cleared without inventing a stair wall', () => {
  const map = world(4, (x, y, z) => x === 0 && z === 0 && y === 2);
  for (const [x, z] of [
    [1, 0],
    [-1, 0],
    [0, 1],
    [0, -1],
  ])
    map.put({ x, y: 0, z, seenAt: Date.now(), traits: [], boxes: [[x, 0, z, x + 1, 0.125, z + 1]] });
  const origin = { x: 0.5, y: 0, z: 0.5 };
  assert.equal(reachable(map, origin), 1);
  const plan = stairStep(map, origin, { x: -10, z: 0 });
  assert.deepEqual(plan, { step: null, dig: [{ x: 0, y: 2, z: 0 }], direction: null });
  map.put({ x: 0, y: 2, z: 0, seenAt: Date.now(), traits: [], boxes: [] });
  assert.equal(reachable(map, origin), pitLimit);
});

test('stairs avoid rock beyond the carried mining tier and reuse cleared steps', () => {
  const pit = world(3, (x, y, z) => (x !== 0 || z !== 0) && y >= 0 && y <= 3);
  const origin = { x: 0.5, y: 0, z: 0.5 };
  const toward = { x: 5, z: 0.5 };
  pit.get(1, 2, 0).traits = ['tier2'];
  assert.notDeepEqual(stairStep(pit, origin, toward, 0)?.step, { x: 1, y: 0, z: 0 }, 'bare hands choose another wall');
  assert.notDeepEqual(stairStep(pit, origin, toward, 1)?.step, { x: 1, y: 0, z: 0 }, 'an insufficient pickaxe cannot cut this wall');
  assert.deepEqual(stairStep(pit, origin, toward, 2)?.step, { x: 1, y: 0, z: 0 });
  for (const y of [1, 2, 3]) pit.put({ x: 1, y, z: 0, seenAt: Date.now(), traits: [], boxes: [] });
  const ready = stairStep(pit, origin, toward, 0);
  assert.deepEqual(ready.step, { x: 1, y: 0, z: 0 });
  assert.deepEqual(ready.dig, [], 'a previously cleared stair needs only the climb');
  pit.put({ x: 0, y: 2, z: 0, seenAt: Date.now(), traits: ['tier2'], boxes: [[0, 0, 0, 1, 1, 1]] });
  assert.equal(stairStep(pit, origin, toward, 0), null, 'every direction still needs takeoff headroom');
});

test('burrow digging uses a carried shovel while respecting required mining tiers', async () => {
  const inventory = {
    inventories: [
      {
        name: 'hotbar',
        slots: [
          { slot: 0, code: null, quantity: 0 },
          { slot: 1, code: 'game:shovel-copper', tool: 'Shovel', toolTier: 2, durability: 10, quantity: 1 },
          { slot: 2, code: 'game:pickaxe-copper', tool: 'Pickaxe', toolTier: 2, durability: 10, quantity: 1 },
          { slot: 3, code: 'game:axe-copper', tool: 'Axe', toolTier: 2, durability: 10, quantity: 1 },
        ],
      },
    ],
  };
  const field = { latest: { activeSlot: 0 } };
  assert.equal(await diggingSlot(field, { material: 'Soil' }, inventory), 1);
  assert.equal(await diggingSlot(field, { material: 'Stone', requiredMiningTier: 2 }, inventory), 2);
  assert.equal(await diggingSlot(field, { material: 'Wood', requiredMiningTier: 1 }, inventory), 3);
  assert.equal(await diggingSlot(field, { material: 'Stone', requiredMiningTier: 3 }, inventory), null);
  inventory.inventories[0].slots[1].durability = 0;
  assert.equal(await diggingSlot(field, { material: 'Soil' }, inventory), 0, 'broken shovel falls back to the current slot');
});

test('digging equips a required tool from a basket even when the hotbar is full', async () => {
  let activeSlot = 1;
  let packState = 0;
  const inventories: any[] = [
    {
      name: 'hotbar',
      slots: [
        { slot: 0, code: 'game:stick', quantity: 4, tool: null },
        { slot: 1, code: 'game:shovel-flint', quantity: 1, tool: 'Shovel', toolTier: 0, durability: 40 },
      ],
    },
    {
      name: 'backpack',
      slots: [
        { slot: 0, code: 'game:axe-flint', quantity: 1, tool: 'Axe', toolTier: 1, durability: 120, bag: false },
        { slot: 1, code: null, quantity: 0, tool: null, bag: false },
      ],
    },
  ];
  const contents = () => ({ state: 'pack-' + packState, inventories: structuredClone(inventories) });
  const field: any = {
    latest: { activeSlot },
    report: () => {},
    observe: async () => structuredClone(field.latest),
    send: async request => {
      if (request.action === 'inventory') return contents();
      if (request.action === 'inventory_move') {
        assert.equal(request.expectedState, 'pack-' + packState);
        const from = inventories.find(i => i.name === request.from.inventory).slots[request.from.slot];
        const to = inventories.find(i => i.name === request.to.inventory).slots[request.to.slot];
        Object.assign(to, structuredClone(from), { slot: request.to.slot });
        Object.assign(from, { code: null, quantity: 0, tool: null, toolTier: null, durability: null });
        packState++;
        return { ok: true };
      }
      if (request.action === 'select') {
        activeSlot = request.slot;
        field.latest.activeSlot = activeSlot;
        return { ok: true };
      }
      throw Error('Unexpected action: ' + request.action);
    },
    until: (condition, options) => until(field, condition, options),
  };

  const selected = { code: 'game:log-grown-maple-ud', material: 'Wood', requiredMiningTier: 1, traits: ['choppable', 'tier:1'] };
  assert.equal(await diggingSlot(field, selected, contents()), 0);
  assert.equal(inventories[0].slots[0].code, 'game:axe-flint');
  assert.equal(inventories[1].slots[1].code, 'game:stick');
});
