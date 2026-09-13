import assert from 'node:assert/strict';
import { test } from 'node:test';
import { moveItems } from '../src/goals/store_items.ts';

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
