import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  finishedFormOnGround,
  formingGround,
  hasFormingOutputRoom,
  inspectKnownFormingSurface,
  needsOpenRecipeSelection,
} from '../src/support/forming.ts';

test('forming surfaces reject loose resources as ground', () => {
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:soil-low-none', code: 'game:soil-low-none', face: 'up' }), true);
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:loosestones-claystone-free', code: 'game:loosestones-claystone-free', face: 'up' }), false);
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:looseflints-claystone-free', code: 'game:looseflints-claystone-free', face: 'up' }), false);
});

test('forming reserves carried room before consuming its surface material', () => {
  const inventory = {
    inventories: [
      { name: 'hotbar', slots: [{ slot: 0, code: 'game:flint', quantity: 2 }] },
      { name: 'backpack', slots: [{ slot: 0, code: 'game:log-placed-maple-ud', quantity: 4, bag: false }] },
    ],
  };
  assert.equal(hasFormingOutputRoom(inventory, 'game:spearhead-flint'), false);
  assert.equal(
    hasFormingOutputRoom(
      { ...inventory, inventories: [...inventory.inventories, { name: 'mouse', slots: [{ slot: 0, code: null }] }] },
      'game:spearhead-flint',
    ),
    false,
  );
  inventory.inventories[1].slots[0] = { slot: 0, code: null, quantity: 0, bag: false };
  assert.equal(hasFormingOutputRoom(inventory, 'game:spearhead-flint'), true);
});

test('forming resumes a selected clay recipe without submitting it again', () => {
  const selected = { forming: { recipe: { output: 'game:storagevessel-red-raw' } } };

  assert.equal(needsOpenRecipeSelection({ controlReady: true }, selected), false);
  assert.equal(needsOpenRecipeSelection({ controlReady: false }, selected), false);
  assert.equal(needsOpenRecipeSelection({ controlReady: false }, { forming: { recipe: null } }), true);
});

test('finished pottery is recognized in ground storage on its former forming cell', () => {
  const detail = { key: 'block:0:1:2:3:game:groundstorage', code: 'game:groundstorage' };

  assert.equal(finishedFormOnGround('clayforming', detail), true);
  assert.equal(finishedFormOnGround('knapping', detail), false);
  assert.equal(finishedFormOnGround('clayforming', { ...detail, code: 'game:air' }), false);
});

test('forming retries a known surface after clearing a leaf obstruction', async () => {
  const cell = { x: 1, y: 2, z: 3 };
  const field = { env: { map: { get: () => ({ code: 'game:knappingsurface' }) } } };
  const selected = { forming: { recipe: { output: 'game:shovelhead-flint' } } };
  let inspections = 0;
  let clearedAt = null;
  const result = await inspectKnownFormingSurface(
    field,
    cell,
    'game:knappingsurface',
    async () => {
      inspections++;
      return clearedAt ? selected : null;
    },
    async (_field, point, limit) => {
      clearedAt = { point, limit };
      return 1;
    },
  );

  assert.equal(result, selected);
  assert.equal(inspections, 11);
  assert.deepEqual(clearedAt, { point: { x: 1.5, y: 2.05, z: 3.5 }, limit: 3 });
});

test('an occluded first selection box does not hide the rest of an observed knapping surface', async () => {
  const cell = { x: 1, y: 100, z: 3 };
  const field = { env: { map: { get: () => ({ code: 'game:knappingsurface' }) } } };
  const selected = { forming: { recipe: { output: 'game:hoehead-flint' } } };
  const result = await inspectKnownFormingSurface(
    field,
    cell,
    'game:knappingsurface',
    async (_field, _cell, point) => (point?.x === 1.5 && point?.z === 3.5 ? selected : null),
    async () => {
      assert.fail('the visible grid does not require cutting leaves');
    },
  );
  assert.equal(result, selected);
});

test('forming does not clear around a surface that is no longer observed', async () => {
  const field = { env: { map: { get: () => ({ code: 'game:air' }) } } };
  let cleared = false;
  const result = await inspectKnownFormingSurface(
    field,
    { x: 1, y: 2, z: 3 },
    'game:knappingsurface',
    async () => null,
    async () => {
      cleared = true;
      return 1;
    },
  );

  assert.equal(result, null);
  assert.equal(cleared, false);
});
