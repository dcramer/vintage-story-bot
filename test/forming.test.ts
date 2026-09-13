import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formingGround, inspectKnownFormingSurface } from '../src/support/forming.ts';

test('forming surfaces reject loose resources as ground', () => {
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:soil-low-none', code: 'game:soil-low-none', face: 'up' }), true);
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:loosestones-claystone-free', code: 'game:loosestones-claystone-free', face: 'up' }), false);
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:looseflints-claystone-free', code: 'game:looseflints-claystone-free', face: 'up' }), false);
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
    async () => (++inspections === 1 ? null : selected),
    async (_field, point, limit) => {
      clearedAt = { point, limit };
      return 1;
    },
  );

  assert.equal(result, selected);
  assert.equal(inspections, 2);
  assert.deepEqual(clearedAt, { point: { x: 1.5, y: 2.05, z: 3.5 }, limit: 3 });
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
