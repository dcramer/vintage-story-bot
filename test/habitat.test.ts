import assert from 'node:assert/strict';
import { test } from 'node:test';
import { habitatsFor, habitatTarget } from '../src/support/habitat.ts';

const column = (x, z, kind): [string, any] => [`${x},${z}`, { x, z, y: 100, kind, step: 0, code: null }];
test('habitat: a search heads for the nearest unwalked place of the right kind', () => {
  const columns = new Map<string, any>([
    ...Array.from({ length: 8 }, (_, i) => column(20 + i, 0, 'canopy')),
    column(40, 0, 'ground'),
    column(41, 0, 'ground'),
    column(44, 0, 'water'),
    column(-30, 0, 'ground'),
    column(-30, 2, 'canopy'),
  ]);
  const surface = { columns };
  const at = { x: 0.5, z: 0.5 };
  assert.deepEqual(habitatsFor('stick'), ['canopy', 'edge']);
  assert.deepEqual(habitatsFor('cattailtops'), ['shore']);
  assert.equal(habitatTarget(surface, at, ['canopy'], () => false).x, 20.5, 'nearest canopy');
  assert.equal(habitatTarget(surface, at, ['shore'], () => false).x, 41.5, 'ground beside water');
  assert.equal(habitatTarget(surface, at, ['edge'], () => false).x, -29.5, 'ground beside trees');
  assert.equal(
    habitatTarget(surface, at, ['canopy'], c => `${Math.floor(c.x / 16)},${Math.floor(c.z / 16)}` === '1,0').x,
    -29.5,
    'the walked area 1,0 is passed over for the next canopy',
  );
  assert.equal(
    habitatTarget(surface, at, ['shore'], c => `${Math.floor(c.x / 16)},${Math.floor(c.z / 16)}` === '2,0'),
    null,
    'a walked area is not searched again',
  );
  assert.equal(habitatTarget(surface, { x: 40, z: 0 }, ['open'], () => false).x, -29.5, 'too close does not count');
});
