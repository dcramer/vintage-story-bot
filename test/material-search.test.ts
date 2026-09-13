import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Search } from '../src/support/search.ts';

for (const source of ['view', 'memory'])
  test(`material search uses ${source} without a handbook callback`, async () => {
    const target = { key: 'reed', kind: 'block', point: { x: 90, y: 0, z: 0 } };
    let known = [];
    let turns = 0;
    let recalls = 0;
    const field = {
      latest: { position: { x: 0, y: 0, z: 0 }, orientation: { yawDegrees: 0 } },
      now: () => 0,
      skipped: new Set(),
      places: { failed: () => 0, search: () => {} },
      targets: () => known,
      scan: async () => [],
      lookAround: async () => {
        turns++;
        if (source === 'view') known = [target];
        return known;
      },
      recall: range => {
        recalls++;
        assert.equal(range, 256);
        known = [target];
        return known;
      },
    };
    const search = new Search(field, { kind: 'coopersreed', match: ['coopersreed'], wanted: () => true, take: async () => true, memoryRange: 256 });
    let approached = null;
    search.approach = async object => {
      approached = object;
    };
    assert.equal(await search.step(), 'approached');
    assert.equal(approached, target);
    assert.equal(turns, 1);
    assert.equal(recalls, source === 'memory' ? 1 : 0);
  });
