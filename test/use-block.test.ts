import assert from 'node:assert/strict';
import { test } from 'node:test';
import useBlock from '../src/goals/use_block.ts';

test('use_block accepts a requested held stack size for multi-item interactions', () => {
  const args = useBlock.schema.parse({
    target: 'block:0:1:2:3:game:pitkiln',
    item: 'game:stick',
    quantity: 4,
  });
  assert.equal(args.quantity, 4);
});
