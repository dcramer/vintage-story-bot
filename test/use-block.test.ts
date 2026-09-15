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

function unchangedTargetField(target: string, infos: string[] = ['']) {
  const state: any = {
    capabilities: [],
    position: { x: 1.5, y: 2, z: 2.5, dimension: 0 },
    body: { eyeHeight: 1.6 },
    activeSlot: 0,
    target: { key: target },
    alive: true,
    controlReady: true,
  };
  let inspections = 0;
  return {
    latest: state,
    report: () => {},
    observe: async () => state,
    aim: async () => state,
    wait: async () => {},
    guard: value => value,
    env: { send: async () => ({ ok: true }) },
    send: async request => {
      if (request.action === 'aim_cell' || request.action === 'select' || request.action === 'interact' || request.action === 'stop')
        return { ok: true };
      if (request.action === 'inspect_target') {
        const info = infos[Math.min(inspections++, infos.length - 1)];
        return { key: target, code: 'game:pitkiln', info };
      }
      if (request.action === 'inventory')
        return { state: 'pack', inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: 'game:firestarter', quantity: 1 }] }] };
      if (request.action === 'observe') return state;
      throw new Error(`Unexpected action ${request.action}`);
    },
  } as any;
}

test('use_block does not treat an unchanged expected code as an observed effect', async () => {
  const target = 'block:0:1:2:3:game:pitkiln';
  const result = await useOnBlock(unchangedTargetField(target), {
    target,
    holdMs: 100,
    expectAfter: 'game:pitkiln',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no_observed_effect');
});

test('use_block verifies a new native target-info state', async () => {
  const target = 'block:0:1:2:3:game:pitkiln';
  const result = await useOnBlock(unchangedTargetField(target, ['1x Raw pot\nUnlit', '1x Raw pot\nUnlit', '1x Raw pot\nLit']), {
    target,
    holdMs: 100,
    expectInfo: 'Lit',
  });

  assert.equal(result.ok, true);
  assert.equal(result.info, '1x Raw pot\nLit');
  assert.equal(result.infoChanged, true);
});
