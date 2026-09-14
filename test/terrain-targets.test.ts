import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Search } from '../src/support/search.ts';
import { terrainTargets } from '../src/support/terrain-targets.ts';

test('material search uses nearby observed terrain without treating stale or distant cells as targets by default', async () => {
  const cells = [
    { x: 1, y: 0, z: 0, code: 'game:soil-low-none', seenAt: 10000 },
    { x: 2, y: 0, z: 0, code: 'game:soil-low-none', seenAt: 1000 },
    { x: 10, y: 0, z: 0, code: 'game:soil-low-none', seenAt: 10000 },
    { x: 0, y: 0, z: 1, code: 'game:soil-low-none', seenAt: 10000, hazard: 'water' },
    { x: 0, y: 0, z: 2, code: 'game:soil-low-none' },
  ];
  const field: any = {
    latest: { position: { x: 0.5, y: 1, z: 0.5, dimension: 0 }, body: { eyeHeight: 1.7 }, pickingRange: 4.5 },
    env: { map: { cells: new Map(cells.map((c, i) => [i, c])) } },
    now: () => 11000,
    skipped: new Set(),
    targets: () => [],
    scan: async () => [],
    places: { failed: () => 0, search: () => {} },
  };
  const candidates = () => terrainTargets(field, ['soil-']);
  const search = new Search(field, { kind: 'soil-', match: ['soil-'], wanted: () => true, candidates, take: async () => true });
  const near = await search.look(8);
  assert.equal(near.length, 1);
  assert.equal(near[0].key, 'block:0:1:0:0:game:soil-low-none');
  assert.equal(near[0].withinPickingRange, true);
  assert.equal(search.targets().length, 1, 'terrain remains a lead even with no block sightings');
  field.skipped.add(near[0].key);
  assert.equal(search.targets().length, 0);
  field.skipped.clear();
  cells[0].code = 'game:air';
  assert.equal(search.targets().length, 0, 'changed terrain is re-read, not kept as a stale sighting');
});

test('material search can follow distant terrain memory without acting on stale nearby cells', () => {
  const cells = [
    { x: 2, y: 0, z: 0, code: 'game:soil-medium-none', seenAt: 1000 },
    { x: 40, y: 0, z: 0, code: 'game:soil-medium-none', seenAt: 1000 },
    { x: 300, y: 0, z: 0, code: 'game:soil-medium-none', seenAt: 1000 },
  ];
  const field: any = {
    latest: { position: { x: 0.5, y: 1, z: 0.5, dimension: 0 }, body: { eyeHeight: 1.7 }, pickingRange: 4.5 },
    env: { map: { cells: new Map(cells.map((cell, i) => [i, cell])) } },
    now: () => 11000,
  };
  const targets = terrainTargets(field, ['soil-medium-'], 256);
  assert.equal(targets.length, 1);
  assert.equal(targets[0].key, 'block:0:40:0:0:game:soil-medium-none');
  assert.equal(targets[0].source, 'memory');
  assert.equal(targets[0].visible, false);
  assert.equal(targets[0].withinPickingRange, false, 'old terrain must be observed again before harvest can act');
});
