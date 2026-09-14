import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectHarvestDrop, failedDropRetryMs, harvestBlockReady, matchesHarvestBlock } from '../src/goals/harvest.ts';
import { Search } from '../src/support/search.ts';

test('top gathering leaves harvested cattail stems for a root request', () => {
  const cut = { kind: 'block', code: 'game:tallplant-coopersreed-land-harvested-snow' };
  assert.equal(matchesHarvestBlock(cut, 'coopersreed', 'cattailtops'), false);
  assert.equal(matchesHarvestBlock(cut, 'coopersreed', 'cattailroot'), true);
  assert.equal(matchesHarvestBlock(cut, 'coopersreed', 'cattail'), true);
  assert.equal(matchesHarvestBlock({ ...cut, code: 'game:tallplant-coopersreed-water-normal-free' }, 'coopersreed', 'cattailtops'), true);
});

test('a harvest does not count an uncollectable drop as productive or retry it immediately', async () => {
  const drop = { key: 'entity:9', kind: 'item', code: 'game:cattailroot' };
  const reports = [];
  const skips = [];
  const field = {
    report: (phase, details) => reports.push({ phase, ...details }),
    skip: (object, ms) => skips.push({ object, ms }),
    seen: new Map([[drop.key, drop]]),
  };
  const collected = await collectHarvestDrop(field, drop, async () => ({
    ok: false,
    reason: 'pickup_failed',
    target: drop.key,
    wanted: 1,
    gained: 0,
  }));
  assert.equal(collected, false);
  assert.deepEqual(skips, [{ object: drop, ms: failedDropRetryMs }]);
  assert.equal(field.seen.has(drop.key), false);
  assert.deepEqual(reports, [{ phase: 'collecting', target: drop.key }]);
});

test('harvest leaves high cliff blocks whose drops the body cannot reach', () => {
  const state = {
    position: { x: 10.5, y: 110, z: 10.5 },
    body: { height: 1.85 },
    motion: { onGround: true, feetInLiquid: false, swimming: false },
  };
  const block = y => ({ kind: 'block', point: { x: 11.5, y, z: 10.5 }, withinPickingRange: true });
  assert.equal(harvestBlockReady(block(111.5), state), true);
  assert.equal(harvestBlockReady(block(114.5), state), false);
});

test('a search reports the actual failed destination when it discovers a pit', () => {
  const position = { x: 40, y: 120, z: 30 };
  const toward = { x: 10, y: 120, z: -20 };
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

test('a search stranded above a lower destination does not call the ridge a pit', () => {
  const position = { x: 40, y: 120, z: 30 };
  const reports = [];
  const field = {
    latest: { position },
    now: () => 0,
    env: { map: { nodeAt: () => position, moves: () => [], gapMoves: () => [] } },
    report: (phase, details) => reports.push({ phase, ...details }),
  };
  const search = new Search(field, { kind: 'material', match: ['coopersreed'], wanted: () => true, take: async () => true });
  assert.equal(search.inPit({ state: 'blocked', reason: 'no_observed_route' }, { x: 10, y: 110, z: -20 }), false);
  assert.equal(search.pit, false);
  assert.deepEqual(reports, []);
});

test('a search reports a pit when a falling full block embeds the grounded body', () => {
  const position = { x: 40.5, y: 120, z: 30.5 };
  const toward = { x: 10, y: 100, z: -20 };
  const reports = [];
  const body = { boxes: [[40, 120, 30, 41, 121, 31]], hazard: false };
  const field = {
    latest: { position },
    now: () => 0,
    env: { map: { nodeAt: () => null, get: (x, y, z) => (x === 40 && y === 120 && z === 30 ? body : null) } },
    report: (phase, details) => reports.push({ phase, ...details }),
  };
  const search = new Search(field, { kind: 'material', match: ['coopersreed'], wanted: () => true, take: async () => true });
  assert.equal(search.inPit({ state: 'blocked', reason: 'no_observed_route' }, toward), true);
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
