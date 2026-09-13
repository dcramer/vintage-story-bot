import assert from 'node:assert/strict';
import { test } from 'node:test';
import { formingGround } from '../src/support/forming.ts';

test('forming surfaces reject loose resources as ground', () => {
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:soil-low-none', code: 'game:soil-low-none', face: 'up' }), true);
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:loosestones-claystone-free', code: 'game:loosestones-claystone-free', face: 'up' }), false);
  assert.equal(formingGround({ key: 'block:0:1:2:3:game:looseflints-claystone-free', code: 'game:looseflints-claystone-free', face: 'up' }), false);
});
