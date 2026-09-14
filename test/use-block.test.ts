import assert from 'node:assert/strict';
import { test } from 'node:test';
import useBlock, { useOnBlock } from '../src/goals/use_block.ts';
import { GoalError } from '../src/runtime/failure.ts';

test('use_block accepts a requested held stack size for multi-item interactions', () => {
  const args = useBlock.schema.parse({
    target: 'block:0:1:2:3:game:pitkiln',
    item: 'game:stick',
    quantity: 4,
  });
  assert.equal(args.quantity, 4);
});

test('use_block refreshes once when inventory sync races a guarded interaction', async () => {
  const target = 'block:0:1:2:3:game:roughhewnfencegate-maple-w-opened-free';
  const state: any = {
    capabilities: [],
    position: { x: 1.5, y: 2, z: 2.5, dimension: 0 },
    body: { eyeHeight: 1.6 },
    activeSlot: 0,
    target: { key: target },
    alive: true,
    controlReady: true,
  };
  let inventoryReads = 0;
  let interactions = 0;
  const field: any = {
    latest: state,
    report: () => {},
    observe: async () => state,
    aim: async () => state,
    wait: async () => {},
    guard: value => value,
    env: { send: async () => ({ ok: true }) },
    send: async request => {
      if (request.action === 'aim_cell') return { ok: true };
      if (request.action === 'inspect_target')
        return interactions
          ? { key: 'block:0:1:2:3:game:roughhewnfencegate-maple-w-closed-free', code: 'game:roughhewnfencegate-maple-w-closed-free' }
          : { key: target, code: 'game:roughhewnfencegate-maple-w-opened-free' };
      if (request.action === 'inventory')
        return {
          state: `pack-${++inventoryReads}`,
          inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: null, quantity: 0 }] }],
        };
      if (request.action === 'interact') {
        interactions++;
        if (interactions === 1) throw new GoalError('game_refused', 'Inventory changed; inspect before interacting.');
        assert.equal(request.expectedState, 'pack-2');
        return { ok: true };
      }
      if (request.action === 'observe') return state;
      if (request.action === 'stop') return { ok: true };
      throw new Error(`Unexpected action ${request.action}`);
    },
  };

  const result = await useOnBlock(field, { target, item: undefined, holdMs: 100, expectAfter: '-closed-' });

  assert.equal(result.ok, true);
  assert.equal(interactions, 2);
});
