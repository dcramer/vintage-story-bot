import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeFirepit } from '../src/goals/firepit.ts';
import { moveItems } from '../src/goals/store_items.ts';
import { until } from '../src/support/fieldwork.ts';

test('firepit creation retries only after a verified no-effect grass placement', async () => {
  const cell = { x: 0, y: 1, z: 0 };
  let aimed = cell;
  let activeSlot = 0;
  let drygrass = 1;
  let firewood = 4;
  let grassAttempts = 0;
  let code: string | null = null;
  const state: any = {
    ok: true,
    alive: true,
    controlReady: true,
    activeSlot,
    position: { x: 1.5, y: 1, z: 0.5, dimension: 0 },
    body: { eyeHeight: 1.6 },
    pickingRange: 5,
    capabilities: ['sneak'],
  };
  const inventory = () => ({
    state: `pack-${drygrass}-${firewood}`,
    inventories: [
      {
        name: 'hotbar',
        slots: [
          { slot: 0, code: drygrass ? 'game:drygrass' : null, quantity: drygrass },
          { slot: 1, code: firewood ? 'game:firewood' : null, quantity: firewood },
        ],
      },
      { name: 'backpack', slots: [] },
    ],
  });
  const selection = () => {
    if (code)
      return {
        ok: true,
        key: `block:0:0:1:0:${code}`,
        code,
        face: 'up',
      };
    return {
      ok: true,
      key: 'block:0:0:0:0:game:soil-low-normal',
      code: 'game:soil-low-normal',
      face: 'up',
    };
  };
  const field: any = {
    latest: state,
    report: () => {},
    wait: async () => {},
    guard: value => value,
    observe: async () => {
      state.activeSlot = activeSlot;
      return state;
    },
    send: async request => {
      if (request.action === 'inventory') return inventory();
      if (request.action === 'select') {
        activeSlot = request.slot;
        state.activeSlot = activeSlot;
        return { ok: true };
      }
      if (request.action === 'aim_cell') {
        aimed = { x: request.x, y: request.y, z: request.z };
        return { ok: true };
      }
      if (request.action === 'inspect_target') return selection();
      if (request.action === 'interact') {
        if (request.expectedItem.code === 'game:drygrass') {
          grassAttempts++;
          if (grassAttempts === 2) {
            drygrass = 0;
            code = 'game:firepit-construct1';
          }
        } else if (request.expectedItem.code === 'game:firewood') {
          firewood--;
          const stage = Number(/^game:firepit-construct(\d)$/.exec(code ?? '')?.[1]);
          code = stage === 4 ? 'game:firepit-cold' : `game:firepit-construct${stage + 1}`;
        }
        return { ok: true };
      }
      return { ok: true };
    },
    until: (condition, options) => until(field, condition, options),
    env: {
      map: {
        get: (_x, y) => (y === 1 ? { code, hazard: null, boxes: [] } : { code: 'game:soil-low-normal', hazard: null, boxes: [[0, 0, 0, 1, 1, 1]] }),
      },
      send: async () => ({ ok: true }),
    },
  };

  const result = await makeFirepit(field, cell);

  assert.equal(aimed.y, 1);
  assert.equal(grassAttempts, 2);
  assert.equal(drygrass, 0);
  assert.equal(firewood, 0);
  assert.deepEqual(result, { ok: true, goal: 'firepit', cell, code: 'game:firepit-cold', verification: 'client_observed' });
});

test('hot food retries only an explicit no-transfer refusal with a fresh reading', async () => {
  for (const submitted of [false, true]) {
    const own = { inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: null as string | null, quantity: 0 }] }] };
    const container = { state: 'hot', slots: [{ slot: 2, code: 'game:vegetable-cookedcattailroot', quantity: 1 }] };
    let attempts = 0;
    const field = {
      report: () => {},
      wait: async () => {},
      assess: () => {},
      send: async request => (request.action === 'observe' ? {} : structuredClone(request.action === 'inventory' ? own : container)),
      env: {
        send: async request => {
          attempts++;
          if (submitted) return { ok: true, moved: 1 }; // No observed delta: must stop.
          if (attempts === 1) {
            container.state = 'cooler';
            return { ok: false, error: 'Container changed; read open_container again. Nothing moved.' };
          }
          assert.equal(request.expectedState, 'cooler');
          own.inventories[0].slots[0] = { slot: 0, code: container.slots[0].code, quantity: 1 };
          container.slots[0].quantity = 0;
          return { ok: true, moved: 1 };
        },
      },
    };
    const result = await moveItems(field, {
      container: structuredClone(container),
      item: 'cookedcattailroot',
      count: 1,
      direction: 'take',
      containerSlots: [2],
    });
    assert.deepEqual(result, submitted ? { moved: 0, reason: 'transfer_unverified' } : { moved: 1 });
    assert.equal(attempts, submitted ? 1 : 2);
  }
});

test('firepit loading accepts a verified source decrease while the fire consumes one item', async () => {
  const makeField = () => {
    const own = { inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: 'game:firewood', quantity: 8 }] }] };
    const container = { state: 'embers', slots: [{ slot: 0, code: null as string | null, quantity: 0 }] };
    const field = {
      report: () => {},
      wait: async () => {},
      assess: () => {},
      send: async request => structuredClone(request.action === 'inventory' ? own : container),
      env: {
        send: async () => {
          own.inventories[0].slots[0] = { slot: 0, code: null, quantity: 0 };
          container.slots[0] = { slot: 0, code: 'game:firewood', quantity: 7 };
          return { ok: true, moved: 8 };
        },
      },
    };
    return { field, container };
  };

  const strict = makeField();
  assert.deepEqual(
    await moveItems(strict.field, {
      container: structuredClone(strict.container),
      item: 'game:firewood',
      count: 8,
      direction: 'store',
      containerSlots: [0],
    }),
    { moved: 0, reason: 'transfer_unverified' },
  );

  const active = makeField();
  assert.deepEqual(
    await moveItems(active.field, {
      container: structuredClone(active.container),
      item: 'game:firewood',
      count: 8,
      direction: 'store',
      containerSlots: [0],
      allowConsumption: true,
    }),
    { moved: 8 },
  );
});

test('firepit transfers use the requested native slot and never take input as output', async () => {
  const own = { inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: 'game:cattailroot', quantity: 2 }] }] };
  const container = { state: 'opened', slots: [0, 1, 2].map(slot => ({ slot, code: null as string | null, quantity: 0 })) };
  const moves = [];
  const field = {
    report: () => {},
    wait: async () => {},
    assess: () => {},
    send: async request => {
      if (request.action === 'observe') return {};
      return structuredClone(request.action === 'inventory' ? own : container);
    },
    env: {
      send: async request => {
        assert.equal(request.action, 'container_move');
        moves.push(request);
        const at = address => (address.inventory === 'container' ? container.slots : own.inventories[0].slots).find(s => s.slot === address.slot);
        const from = at(request.from);
        const to = at(request.to);
        to.code = from.code;
        to.quantity += request.quantity;
        from.quantity -= request.quantity;
        if (!from.quantity) from.code = null;
        return { ok: true, moved: request.quantity };
      },
    },
  };
  assert.deepEqual(await moveItems(field, { container, item: 'game:cattailroot', count: 1, direction: 'store', containerSlots: [1] }), { moved: 1 });
  assert.equal(moves[0].to.slot, 1);
  assert.equal(container.slots[0].quantity, 0, 'empty fuel slot cannot capture food');
  assert.deepEqual(await moveItems(field, { container, item: 'game:cattailroot', count: 1, direction: 'take', containerSlots: [2] }), {
    moved: 0,
    reason: 'none_found',
  });
  assert.equal(moves.length, 1, 'unfinished input stays in the firepit');
});
