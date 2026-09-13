import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocate } from '../src/goals/craft_item.ts';

test('a repeated craft stages consumables together without duplicating a retained tool', () => {
  const plan = allocate(
    {
      ingredients: [
        { slot: 0, quantity: 1, consume: false, matches: [{ inventory: 'hotbar', slot: 9, quantity: 1 }] },
        { slot: 3, quantity: 1, consume: true, matches: [{ inventory: 'hotbar', slot: 2, quantity: 2 }] },
      ],
    },
    2,
  );
  assert.deepEqual(
    plan?.map(move => move.quantity),
    [1, 2],
  );
});

test('repeated tool recipes reuse the retained tool before choosing another carried tool', () => {
  assert.deepEqual(
    allocate({
      ingredients: [
        {
          slot: 0,
          quantity: 1,
          matches: [
            { inventory: 'hotbar', slot: 5, quantity: 1 },
            { inventory: 'craftinggrid', slot: 0, quantity: 1 },
          ],
        },
        { slot: 3, quantity: 1, matches: [{ inventory: 'hotbar', slot: 7, quantity: 2 }] },
      ],
    }),
    [{ from: { inventory: 'hotbar', slot: 7 }, to: { inventory: 'craftinggrid', slot: 3 }, quantity: 1 }],
  );
});

test('an ingredient already in place cannot be allocated a second time', () => {
  const matches = [{ inventory: 'craftinggrid', slot: 0, quantity: 1 }];
  assert.equal(
    allocate({
      ingredients: [
        { slot: 0, quantity: 1, matches },
        { slot: 1, quantity: 1, matches },
      ],
    }),
    null,
  );
});
