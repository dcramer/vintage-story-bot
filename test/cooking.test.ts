import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cook } from '../src/goals/cook.ts';
import { remember } from '../src/support/facts.ts';
import { ignite } from '../src/support/fire.ts';

test('ignition keeps trying verified no-effects beyond the old stochastic cap', async () => {
  const target = 'block:0:0:0:0:game:firepit-cold';
  const state = {
    activeSlot: 0,
    alive: true,
    body: { eyeHeight: 1.6 },
    capabilities: ['long_hand_hold'],
    controlReady: true,
    position: { x: 2.5, y: 0, z: 0.5, dimension: 0 },
  };
  const inventory = {
    state: 'inventory-state',
    inventories: [
      {
        name: 'hotbar',
        slots: [{ slot: 0, code: 'game:firestarter', quantity: 1, durability: 20 }],
      },
      { name: 'backpack', slots: [] },
    ],
  };
  let attempts = 0;
  const selected = () => ({
    ok: true,
    code: attempts >= 13 ? 'game:firepit-lit' : 'game:firepit-cold',
    key: attempts >= 13 ? 'block:0:0:0:0:game:firepit-lit' : target,
  });
  const send = async request => {
    if (request.action === 'observe') return state;
    if (request.action === 'aim_cell' || request.action === 'select' || request.action === 'stop') return { ok: true };
    if (request.action === 'inspect_target') return selected();
    if (request.action === 'inventory') return structuredClone(inventory);
    if (request.action === 'interact') {
      attempts++;
      return { ok: true };
    }
    throw Error(`Unexpected action ${request.action}`);
  };
  const field = {
    latest: state,
    env: { send },
    send,
    observe: async () => state,
    report: () => {},
    guard: value => value,
    wait: async () => {},
    until: async predicate => {
      assert.equal(predicate(state), true);
      return { met: true, state };
    },
  };

  const result = await ignite(field, { target, lit: 'firepit-lit', holdMs: 1 });
  assert.equal(result.ok, true);
  assert.equal(attempts, 13);
});

test('cooking refuses to ignite when it cannot move clear of the cold firepit', async () => {
  remember('test:root', { combustible: { smeltsInto: 'test:cooked-root', smeltedRatio: 1 } });
  remember('test:cooked-root', { nutrition: { saturation: 100, health: 0 } });
  for (const available of [false, true]) {
    let walked = false;
    const field = {
      latest: { position: { x: 0.7, y: 0, z: 0.5 }, body: { halfWidth: 0.3 } },
      observe: async () => field.latest,
      approach: (_target, exclude) => {
        assert.equal(exclude({ x: 1.5, z: 0.5 }), true, 'leave room for arrival tolerance');
        assert.equal(exclude({ x: 2.5, z: 0.5 }), false);
        return available ? { x: 2.5, y: 0, z: 0.5 } : null;
      },
      walk: async () => {
        walked = true;
        return { state: 'blocked', reason: 'no_progress' };
      },
      send: async () => {
        throw Error('must not interact while standing in the firepit');
      },
    };
    const result = await cook(field, { target: 'block:0:0:0:0:game:firepit-cold', item: 'test:root', count: 2, fuel: 4 });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'no_safe_cooking_position');
    assert.equal(walked, available);
  }
});

test('cooking does not retry consumed fuel and only continues when the fire is visibly lit', async () => {
  remember('test:root', { combustible: { smeltsInto: 'test:cooked-root', smeltedRatio: 1 } });
  remember('test:cooked-root', { nutrition: { saturation: 100, health: 0 } });
  for (const burning of [true, false]) {
    const own = [
      { slot: 0, code: 'test:root', quantity: 1 },
      { slot: 1, code: 'game:firewood', quantity: 1 },
      { slot: 2, code: null, quantity: 0 },
    ];
    const slots = [0, 1, 2].map(slot => ({ slot, code: null, quantity: 0 }));
    const moves = [];
    let lit = false,
      opens = 0;
    const key = () => `block:0:0:0:0:game:firepit-${lit ? 'lit' : 'extinct'}`;
    const state = { ok: true, controlReady: true, position: { x: 2.5, y: 0, z: 0.5 }, body: { halfWidth: 0.3, eyeHeight: 1.6 } };
    const contents = () => structuredClone({ ok: true, state: 'container', target: key(), slots });
    const send = async request => {
      if (request.action === 'observe') return state;
      if (request.action === 'aim_cell' || request.action === 'close_container') return { ok: true };
      if (request.action === 'inspect_target') return { ok: true, key: key() };
      if (request.action === 'inventory') return structuredClone({ inventories: [{ name: 'hotbar', slots: own }] });
      if (request.action === 'container_slots') return contents();
      if (request.action === 'open_container') {
        opens++;
        return contents();
      }
      if (request.action === 'container_move') {
        const from = (request.from.inventory === 'container' ? slots : own)[request.from.slot];
        const to = (request.to.inventory === 'container' ? slots : own)[request.to.slot];
        moves.push(from.code);
        to.code = from.code;
        to.quantity += request.quantity;
        from.quantity -= request.quantity;
        if (!from.quantity) from.code = null;
        if (to === slots[0]) {
          to.quantity--;
          lit = burning;
        }
        return { ok: true, moved: request.quantity };
      }
      throw Error(`Unexpected action ${request.action}`);
    };
    const field = {
      latest: state,
      env: { send },
      send,
      observe: async () => state,
      assess: () => {},
      report: () => {},
      wait: async ms => {
        if (opens >= 2 && ms === 1000 && lit) {
          slots[1].code = null;
          slots[1].quantity = 0;
          slots[2].code = 'test:cooked-root';
          slots[2].quantity = 1;
        }
      },
    };
    const result = await cook(field, { target: key(), item: 'test:root', count: 1, fuel: 1 });
    assert.equal(result.ok, burning);
    assert.deepEqual(moves, burning ? ['test:root', 'game:firewood', 'test:cooked-root'] : ['test:root', 'game:firewood']);
    if (burning) assert.equal(result.moved, 1);
    else assert.equal(result.reason, 'transfer_unverified');
  }
});
