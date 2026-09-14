import assert from 'node:assert/strict';
import { test } from 'node:test';
import { changeBlock } from '../src/support/blocks.ts';

test('block work aims at the native selection box rather than the empty cell center', async () => {
  const target = 'block:0:1:0:0:game:tallgrass-short-free';
  let aimed = false;
  const field = {
    latest: { position: { x: 0.5, y: 0, z: 0.5, dimension: 0 }, motion: { onGround: true }, body: { eyeHeight: 1.6 }, activeSlot: 0 },
    observe: async () => field.latest,
    report: () => {},
    aim: async () => assert.fail('The cell center is outside this plant selection box'),
    send: async request => {
      switch (request.action) {
        case 'aim_cell':
          assert.deepEqual([request.x, request.y, request.z], [1, 0, 0]);
          aimed = true;
          return { ok: true };
        case 'inspect_target':
          assert.ok(aimed);
          return { key: target };
        case 'inventory':
          return { state: 'owned', inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: null, quantity: 0 }] }] };
        case 'block_action_begin':
          assert.equal(request.target, target);
          return { state: 'changed', after: 'game:air', changedForMs: 1000 };
        case 'select':
          return { ok: true };
        default:
          assert.fail(request.action);
      }
    },
  };
  assert.equal((await changeBlock(field, 'dig', { target })).ok, true);
});

test('oriented placement reaches the native block action unchanged', async () => {
  const target = 'block:0:0:0:0:game:soil-medium-normal';
  let begun = false;
  const field = {
    latest: {
      position: { x: -1.5, y: 1, z: 0.5, dimension: 0 },
      motion: { onGround: true },
      body: { eyeHeight: 1.6 },
      activeSlot: 0,
      world: { gameMode: 'Survival' },
    },
    observe: async () => field.latest,
    report: () => {},
    wait: async () => {},
    send: async request => {
      switch (request.action) {
        case 'select':
        case 'aim_cell':
          return { ok: true };
        case 'inspect_target':
          return { key: target, face: 'up' };
        case 'inventory':
          return {
            state: 'owned',
            inventories: [
              {
                name: 'hotbar',
                slots: [{ slot: 0, code: 'game:roughhewnfencegate-maple-n-closed-free', quantity: begun ? 0 : 1, itemClass: 'Block' }],
              },
            ],
          };
        case 'block_action_begin':
          assert.equal(request.placementAxis, 'w');
          begun = true;
          return { state: 'changed', before: 'game:air', after: 'game:roughhewnfencegate-maple-w-closed-free', changedForMs: 1000 };
        default:
          assert.fail(request.action);
      }
    },
  };
  const placed = await changeBlock(field, 'place', {
    target,
    face: 'up',
    slot: 0,
    expectedItem: 'game:roughhewnfencegate-maple-n-closed-free',
    placementAxis: 'w',
  });
  assert.equal(placed.ok, true);
  assert.ok('after' in placed);
  assert.equal(placed.after, 'game:roughhewnfencegate-maple-w-closed-free');
});
