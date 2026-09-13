import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Search } from '../src/support/search.ts';

test('a search reports the actual failed destination when it discovers a pit', () => {
  const position = { x: 40, y: 120, z: 30 };
  const toward = { x: 10, y: 100, z: -20 };
  const reports = [];
  const field = {
    latest: { position },
    now: () => 0,
    env: { map: { nodeAt: () => position, moves: () => [], gapMoves: () => [] } },
    report: (phase, details) => reports.push({ phase, ...details }),
  };
  const search = new Search(field, { kind: 'material', match: ['coopersreed'], wanted: () => true, take: async () => true });
  assert.equal(search.inPit({ state: 'blocked', reason: 'no_observed_route' }, toward), true);
  assert.deepEqual(search.pitToward, { x: 10, z: -20 });
  assert.deepEqual(reports, [{ phase: 'pit', position, toward: { x: 10, z: -20 } }]);
});

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
