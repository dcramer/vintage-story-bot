import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveItems } from '../src/goals/store_items.ts';

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
