import assert from 'node:assert/strict';
import { test } from 'node:test';
import { allocate, craftDestination } from '../src/goals/craft_item.ts';

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

test('wildcard ingredients do not mix incompatible concrete stacks in one grid slot', () => {
  const matches = [
    { inventory: 'hotbar', slot: 5, quantity: 2 },
    { inventory: 'backpack', slot: 7, quantity: 64 },
    { inventory: 'backpack', slot: 8, quantity: 4 },
  ];
  const inventory = {
    inventories: [
      { name: 'hotbar', slots: [{ slot: 5, code: 'game:soil-medium-none', quantity: 2 }] },
      {
        name: 'backpack',
        slots: [
          { slot: 7, code: 'game:soil-low-none', quantity: 64 },
          { slot: 8, code: 'game:soil-low-none', quantity: 4 },
        ],
      },
    ],
  };
  const plan = allocate(
    {
      ingredients: Array.from({ length: 6 }, (_, slot) => ({ slot, quantity: 1, consume: true, matches })),
    },
    10,
    inventory,
  );
  assert.equal(
    plan?.reduce((sum, step) => sum + step.quantity, 0),
    60,
  );
  assert.ok(
    plan?.every(step => step.from.inventory === 'backpack'),
    'the two medium soil blocks cannot share a grid slot with low soil',
  );
});

test('a wearable craft can go into an empty bag slot when the ordinary pack is full', () => {
  const inventory = {
    inventories: [
      { name: 'hotbar', slots: [{ slot: 0, code: 'game:cattailtops', quantity: 1 }] },
      { name: 'backpack', slots: [{ slot: 0, code: null, quantity: 0, bag: true }] },
    ],
  };
  const destination = craftDestination(inventory, 'game:basket-normal-reed', 1, { bagSlots: 3, maxStackSize: 1 });
  assert.equal(destination?.inventory, 'backpack');
  assert.equal(destination?.slot, 0);
  assert.equal(craftDestination(inventory, 'game:packeddirt', 6, { maxStackSize: 64 }), undefined);
  assert.equal(craftDestination(inventory, 'game:basket-normal-reed', 2, { bagSlots: 3, maxStackSize: 1 }), undefined);
});
