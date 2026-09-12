import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ingestRunMetrics, mergeRunMetric, publicBot } from '../report/runs.mjs';
import { RunMetrics } from '../src/runtime/run-metrics.ts';

const state = (lifeId, observedAt, x, z, alive = true) => ({
  observedAt,
  alive,
  life: { session: lifeId },
  position: { x, y: 100, z, dimension: 0 },
});
const inventory = contents => ({
  inventories: [
    { name: 'hotbar', slots: contents.map(([code, quantity], slot) => ({ slot, code, quantity })) },
    { name: 'backpack', slots: [] },
  ],
});

test('run metrics measure one life from observed movement without counting teleports as travel', () => {
  const metrics = new RunMetrics('controller-1');
  assert.equal(metrics.observeState(state('life-1', 1000, 0, 0)).transition, true);
  metrics.observeState(state('life-1', 2000, 3, 4));
  metrics.observeState(state('life-1', 3000, 3, 4));
  metrics.observeState(state('life-1', 4000, 100, 100));
  const ended = metrics.observeState(state('life-1', 5000, 100, 100, false));
  assert.equal(ended.transition, true);
  assert.deepEqual(ended.data, {
    version: 1,
    segmentId: 'controller-1:1',
    lifeId: 'life-1',
    segmentStartedAt: 1000,
    observedAt: 5000,
    endedAt: 5000,
    alive: false,
    origin: { x: 0, y: 100, z: 0, dimension: 0 },
    position: { x: 100, y: 100, z: 100, dimension: 0 },
    farthest: { x: 100, y: 100, z: 100, dimension: 0 },
    durationMs: 4000,
    distance: 5,
    movementSamples: 1,
    estimatedSteps: 7,
    maxFromOrigin: 141.4,
    discontinuities: 1,
    items: { gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0, byCode: [] },
  });
});

test('run metrics classify owned inventory gains by the work in progress', () => {
  const metrics = new RunMetrics('controller-1');
  metrics.observeState(state('life-1', 1000, 0, 0));
  metrics.observeInventory(inventory([]));
  metrics.observeInventory(inventory([['game:stick', 3]]), 'gather');
  metrics.observeInventory(
    inventory([
      ['game:stick', 2],
      ['game:axe-granite', 1],
    ]),
    'craft',
  );
  metrics.observeInventory(
    inventory([
      ['game:stick', 5],
      ['game:axe-granite', 1],
      ['game:fruit-blueberry', 4],
    ]),
    'retrieve_body',
  );
  assert.deepEqual(metrics.view().items, {
    gained: 11,
    gathered: 3,
    crafted: 1,
    recovered: 7,
    other: 0,
    byCode: [
      { code: 'game:stick', gained: 6, gathered: 3, crafted: 0, recovered: 3, other: 0 },
      { code: 'game:fruit-blueberry', gained: 4, gathered: 0, crafted: 0, recovered: 4, other: 0 },
      { code: 'game:axe-granite', gained: 1, gathered: 0, crafted: 1, recovered: 0, other: 0 },
    ],
  });
});

test('run metrics start a fresh segment when the game life id changes', () => {
  const metrics = new RunMetrics('controller-1');
  metrics.observeState(state('life-1', 1000, 0, 0));
  metrics.observeState(state('life-1', 2000, 1, 0));
  metrics.observeInventory(inventory([]));
  metrics.observeInventory(inventory([['game:stick', 2]]), 'gather');
  const next = metrics.observeState(state('life-2', 3000, 20, 20));
  assert.equal(next.transition, true);
  assert.equal(next.data.segmentId, 'controller-1:2');
  assert.equal(next.data.lifeId, 'life-2');
  assert.equal(next.data.distance, 0);
  assert.equal(next.data.items.gained, 0);
});

test('run metrics start a fresh run when the same game session respawns', () => {
  const metrics = new RunMetrics('controller-1');
  metrics.observeState(state('game-session', 1000, 0, 0));
  metrics.observeState(state('game-session', 2000, 3, 4));
  metrics.observeInventory(inventory([]));
  metrics.observeInventory(inventory([['game:stick', 2]]), 'gather');
  metrics.observeState(state('game-session', 3000, 3, 4, false));

  const revived = metrics.observeState(state('game-session', 4000, 20, 20, true));
  assert.equal(revived.transition, true);
  assert.equal(revived.data.segmentId, 'controller-1:2');
  assert.equal(revived.data.lifeId, 'game-session');
  assert.equal(revived.data.segmentStartedAt, 4000);
  assert.equal(revived.data.endedAt, null);
  assert.equal(revived.data.alive, true);
  assert.equal(revived.data.distance, 0);
  assert.equal(revived.data.items.gained, 0);
});

test('fleet metrics join controller segments idempotently and archive completed lives', () => {
  const bot: any = {};
  const metric = (segmentId, distance, gathered, observedAt = 2000, alive = true, lifeId = 'life-1') => ({
    segmentId,
    lifeId,
    segmentStartedAt: segmentId === 'one' ? 1000 : 2000,
    observedAt,
    endedAt: alive ? null : observedAt,
    alive,
    origin: { x: segmentId === 'one' ? 0 : 3, y: 100, z: segmentId === 'one' ? 0 : 4, dimension: 0 },
    position: { x: 3, y: 100, z: 4, dimension: 0 },
    distance,
    movementSamples: distance,
    maxFromOrigin: distance,
    discontinuities: 0,
    items: {
      byCode: [{ code: 'game:stick', gained: gathered, gathered, crafted: 0, recovered: 0, other: 0 }],
    },
  });
  mergeRunMetric(bot, metric('one', 5, 2));
  mergeRunMetric(bot, metric('one', 5, 2));
  mergeRunMetric(bot, metric('two', 4, 3, 3000));
  assert.equal(bot.runs.current.distance, 9);
  assert.equal(bot.runs.current.items.gathered, 5);
  assert.equal(bot.runs.current.controllerSegments, 2);
  assert.equal(publicBot(bot).runSegments, undefined);

  const died = mergeRunMetric(bot, metric('two', 4, 3, 4000, false));
  assert.equal(died.transition, true);
  assert.equal(bot.runs.current.durationMs, 3000);
  mergeRunMetric(bot, metric('three', 0, 0, 5000, true, 'life-2'));
  assert.equal(bot.runs.recent.length, 1);
  assert.equal(bot.runs.recent[0].lifeId, 'life-1');
  assert.equal(bot.runs.current.lifeId, 'life-2');
});

test('fleet metrics keep an alive run across controller and client session restarts', () => {
  const bot: any = {};
  const metric = (segmentId, lifeId, startedAt, observedAt, distance) => ({
    segmentId,
    lifeId,
    segmentStartedAt: startedAt,
    observedAt,
    endedAt: null,
    alive: true,
    origin: { x: distance, y: 100, z: 0, dimension: 0 },
    position: { x: distance + 1, y: 100, z: 0, dimension: 0 },
    distance,
    movementSamples: distance,
    maxFromOrigin: 1,
    discontinuities: 0,
    items: { byCode: [] },
  });

  mergeRunMetric(bot, metric('controller-1', 'mod-session-1', 1000, 2000, 5));
  mergeRunMetric(bot, metric('controller-2', 'mod-session-2', 3000, 4000, 4));
  assert.equal(bot.runs.recent.length, 0);
  assert.equal(bot.runs.current.lifeId, 'mod-session-2');
  assert.equal(bot.runs.current.startedAt, 1000);
  assert.equal(bot.runs.current.controllerSegments, 2);
  assert.equal(bot.runs.current.distance, 9);
});

test('fleet metrics archive a death when the same game session respawns', () => {
  const bot: any = {};
  const metric = (observedAt, alive) => ({
    segmentId: 'controller-1',
    lifeId: 'stable-game-session',
    segmentStartedAt: alive ? observedAt : 1000,
    observedAt,
    endedAt: alive ? null : observedAt,
    alive,
    origin: { x: 0, y: 100, z: 0, dimension: 0 },
    position: { x: alive ? 10 : 5, y: 100, z: 0, dimension: 0 },
    distance: alive ? 0 : 5,
    movementSamples: alive ? 0 : 5,
    maxFromOrigin: alive ? 0 : 5,
    discontinuities: 0,
    items: { byCode: [] },
  });

  mergeRunMetric(bot, metric(2000, false));
  const revived = mergeRunMetric(bot, metric(3000, true));
  assert.equal(revived.transition, true);
  assert.equal(bot.runs.recent.length, 1);
  assert.equal(bot.runs.recent[0].alive, false);
  assert.equal(bot.runs.recent[0].durationMs, 1000);
  assert.equal(bot.runs.current.alive, true);
  assert.equal(bot.runs.current.endedAt, null);
  assert.equal(bot.runs.current.startedAt, 3000);
  assert.equal(bot.runs.current.distance, 0);

  const stale = { ...metric(3500, true), segmentId: 'old-controller', segmentStartedAt: 1000, distance: 99 };
  assert.equal(mergeRunMetric(bot, stale).changed, false);
  assert.equal(bot.runs.current.controllerSegments, 1);
  assert.equal(bot.runs.current.distance, 0);
});

test('fleet metrics recover a missed dead sample from the respawn trail marker', () => {
  const bot: any = {
    trail: [{ at: 2000, x: 5, y: 100, z: 0, dimension: 0 }],
  };
  const metric = (segmentId, startedAt, observedAt, distance, x) => ({
    segmentId,
    lifeId: 'stable-game-session',
    segmentStartedAt: startedAt,
    observedAt,
    endedAt: null,
    alive: true,
    origin: { x, y: 100, z: 0, dimension: 0 },
    position: { x: x + distance, y: 100, z: 0, dimension: 0 },
    distance,
    movementSamples: distance,
    maxFromOrigin: distance,
    discontinuities: 0,
    items: { byCode: [] },
  });

  mergeRunMetric(bot, metric('before', 1000, 2000, 5, 0));
  const revived = metric('after', 3000, 4000, 2, 20);
  mergeRunMetric(bot, revived);
  assert.equal(bot.runs.recent.length, 0);
  bot.trail.push({ at: 3200, x: 20, y: 100, z: 20, dimension: 0, discontinuity: 'respawn' });

  const healed = mergeRunMetric(bot, { ...revived, observedAt: 5000, distance: 3 });
  assert.equal(healed.transition, true);
  assert.equal(bot.runs.recent.length, 1);
  assert.equal(bot.runs.recent[0].alive, false);
  assert.equal(bot.runs.recent[0].endedAt, 3000);
  assert.equal(bot.runs.recent[0].distance, 5);
  assert.deepEqual(bot.runs.recent[0].position, { x: 5, y: 100, z: 0, dimension: 0 });
  assert.equal(bot.runs.current.startedAt, 3000);
  assert.equal(bot.runs.current.distance, 3);
  assert.equal(bot.runs.current.controllerSegments, 1);
});

test('fleet metrics heal a revived run polluted by a pre-death segment', () => {
  const bot: any = {
    runs: {
      current: {
        lifeId: 'stable-game-session',
        startedAt: 1000,
        observedAt: 2500,
        endedAt: null,
        alive: true,
        spawn: { x: 0, y: 100, z: 0, dimension: 0 },
        position: { x: 9, y: 100, z: 0, dimension: 0 },
        durationMs: 1500,
        distance: 99,
        movementSamples: 99,
        estimatedSteps: 132,
        maxFromSpawn: 9,
        discontinuities: 0,
        controllerSegments: 2,
        items: { gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0, byCode: [] },
      },
      recent: [{ lifeId: 'stable-game-session', startedAt: 1000, observedAt: 2000, endedAt: 2000, alive: true }],
    },
    runSegments: {
      old: { observedAt: 2500, startedAt: 1000, distance: 99, movementSamples: 99, discontinuities: 0, items: {} },
    },
  };
  const fresh = {
    segmentId: 'new-controller',
    lifeId: 'stable-game-session',
    segmentStartedAt: 3000,
    observedAt: 3500,
    endedAt: null,
    alive: true,
    origin: { x: 10, y: 100, z: 0, dimension: 0 },
    position: { x: 12, y: 100, z: 0, dimension: 0 },
    distance: 2,
    movementSamples: 2,
    maxFromOrigin: 2,
    discontinuities: 0,
    items: { byCode: [] },
  };

  mergeRunMetric(bot, fresh);
  assert.equal(bot.runs.recent[0].alive, false);
  assert.equal(bot.runs.current.startedAt, 3000);
  assert.equal(bot.runs.current.distance, 2);
  assert.equal(bot.runs.current.controllerSegments, 1);
});

test('fleet metrics fold false client-restart archives back into the living run', () => {
  const bot: any = {
    runs: {
      current: {
        lifeId: 'mod-session-2',
        startedAt: 3000,
        observedAt: 3500,
        endedAt: null,
        alive: true,
        spawn: { x: 10, y: 100, z: 0, dimension: 0 },
        position: { x: 12, y: 100, z: 0, dimension: 0 },
        durationMs: 500,
        distance: 2,
        movementSamples: 2,
        estimatedSteps: 3,
        maxFromSpawn: 2,
        discontinuities: 0,
        controllerSegments: 1,
        items: { gained: 0, gathered: 0, crafted: 0, recovered: 0, other: 0, byCode: [] },
      },
      recent: [
        {
          lifeId: 'mod-session-1',
          startedAt: 1000,
          observedAt: 2500,
          endedAt: null,
          alive: true,
          spawn: { x: 0, y: 100, z: 0, dimension: 0 },
          position: { x: 10, y: 100, z: 0, dimension: 0 },
          durationMs: 1500,
          distance: 10,
          movementSamples: 10,
          estimatedSteps: 13,
          maxFromSpawn: 10,
          discontinuities: 0,
          controllerSegments: 1,
          items: {
            byCode: [{ code: 'game:stick', gained: 2, gathered: 2, crafted: 0, recovered: 0, other: 0 }],
          },
        },
      ],
    },
    runSegments: {
      current: { observedAt: 3500, startedAt: 3000, distance: 2, movementSamples: 2, discontinuities: 0, items: {} },
    },
  };
  const current = {
    segmentId: 'current',
    lifeId: 'mod-session-2',
    segmentStartedAt: 3000,
    observedAt: 4000,
    endedAt: null,
    alive: true,
    origin: { x: 10, y: 100, z: 0, dimension: 0 },
    position: { x: 13, y: 100, z: 0, dimension: 0 },
    distance: 3,
    movementSamples: 3,
    maxFromOrigin: 3,
    discontinuities: 0,
    items: { byCode: [] },
  };

  mergeRunMetric(bot, current);
  assert.equal(bot.runs.recent.length, 0);
  assert.equal(bot.runs.current.startedAt, 1000);
  assert.equal(bot.runs.current.distance, 13);
  assert.equal(bot.runs.current.controllerSegments, 2);
  assert.equal(bot.runs.current.items.gathered, 2);
  assert.deepEqual(bot.runs.current.spawn, { x: 0, y: 100, z: 0, dimension: 0 });
  assert.equal(bot.runs.current.maxFromSpawn, 13);
});

test('fleet metrics consume transition logs and latest snapshots only once', () => {
  const bot: any = {};
  const data = {
    segmentId: 'one',
    lifeId: 'life-1',
    segmentStartedAt: 1000,
    observedAt: 2000,
    endedAt: null,
    alive: true,
    origin: { x: 0, y: 100, z: 0, dimension: 0 },
    position: { x: 1, y: 100, z: 0, dimension: 0 },
    distance: 1,
    movementSamples: 1,
    maxFromOrigin: 1,
    discontinuities: 0,
    items: { byCode: [] },
  };
  const result = ingestRunMetrics(bot, { run: { at: 2000, data } }, [{ topic: 'run', at: 2000, data }]);
  assert.equal(result.changed, true);
  assert.equal(bot.runs.current.distance, 1);
  assert.equal(bot.runs.current.controllerSegments, 1);
});
