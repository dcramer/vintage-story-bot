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
  assert.equal(habitatTarget(surface, at, ['canopy'], new Map()).x, 20.5, 'nearest canopy');
  assert.equal(habitatTarget(surface, at, ['shore'], new Map()).x, 41.5, 'ground beside water');
  assert.equal(habitatTarget(surface, at, ['edge'], new Map()).x, -29.5, 'ground beside trees');
  assert.equal(habitatTarget(surface, at, ['canopy'], new Map([['1,0', 1]])).x, -29.5, 'the walked area 1,0 is passed over for the next canopy');
  assert.equal(habitatTarget(surface, at, ['shore'], new Map([['2,0', 1]])), null, 'a walked area is not searched again');
  assert.equal(habitatTarget(surface, { x: 40, z: 0 }, ['open'], new Map()).x, -29.5, 'too close does not count');
});
