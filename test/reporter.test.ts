import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reporter } from '../src/runtime/reporter.ts';

test('fleet reporter keeps frames and far-view columns local', async () => {
  let report;
  const reporter = new Reporter({
    url: 'https://fleet.test',
    token: 'token',
    id: 'Atlas',
    intervalMs: 60000,
    fetch: async (_url, request) => {
      report = JSON.parse(request.body as string);
      return new Response(null, { status: 204 });
    },
  });
  reporter.publish('map', { columns: [[0, 0, 4, 'ground', 1, 'soil', 1, 0x112233]] }, { coalesce: true });
  reporter.publish('frame', { tick: 1 }, { coalesce: true });
  reporter.publish('navigation', { id: 'nav-1', state: 'walking' }, { coalesce: true });
  await reporter.flush();
  reporter.close();
  assert.deepEqual(Object.keys(report.topics), ['navigation']);
  assert.deepEqual(report.log, []);
});

test('fleet reporter keeps goal intent, script and subgoal', async () => {
  let report;
  const reporter = new Reporter({
    url: 'https://fleet.test',
    token: 'token',
    id: 'Kiln',
    intervalMs: 60000,
    fetch: async (_url, request) => {
      report = JSON.parse(request.body as string);
      return new Response(null, { status: 204 });
    },
  });
  reporter.publish('goal', {
    id: 'goal-1',
    kind: 'goal_script',
    intent: 'Bring provisions home',
    active: true,
    state: 'running',
    args: { intent: 'Bring provisions home', goalScript: 'await goals.forage({ count: 32 });' },
    progress: { phase: 'running_goal', subgoal: { kind: 'forage', args: { count: 32 }, progress: { phase: 'harvesting' } } },
  });
  await reporter.flush();
  reporter.close();
  assert.equal(report.topics.goal.data.intent, 'Bring provisions home');
  assert.deepEqual(report.topics.goal.data.args, { intent: 'Bring provisions home', goalScript: 'await goals.forage({ count: 32 });' });
  assert.equal(report.topics.goal.data.progress.subgoal.kind, 'forage');
  assert.equal(report.topics.goal.data.args.goalScript.includes('goals.forage'), true);
});

test('fleet reporter keeps cumulative run metrics and transition records', async () => {
  let report;
  const reporter = new Reporter({
    url: 'https://fleet.test',
    token: 'token',
    id: 'Kiln',
    intervalMs: 60000,
    fetch: async (_url, request) => {
      report = JSON.parse(request.body as string);
      return new Response(null, { status: 204 });
    },
  });
  const run = { segmentId: 'controller-1', lifeId: 'life-1', observedAt: 2000, distance: 12.5, estimatedSteps: 17 };
  reporter.publish('run', run);
  await reporter.flush();
  reporter.close();
  assert.deepEqual(report.topics.run.data, run);
  assert.deepEqual(report.log, [{ topic: 'run', at: report.log[0].at, data: run }]);
});

test('fleet reporter preserves death and revival boundaries when an event flood is trimmed', async () => {
  let report;
  const reporter = new Reporter({
    url: 'https://fleet.test',
    token: 'token',
    id: 'Kiln',
    intervalMs: 60000,
    maxBytes: 4096,
    fetch: async (_url, request) => {
      report = JSON.parse(request.body as string);
      return new Response(null, { status: 204 });
    },
  });
  const run = (segmentId, observedAt, alive) => ({
    segmentId,
    lifeId: 'life-1',
    segmentStartedAt: alive ? observedAt : 1000,
    observedAt,
    endedAt: alive ? null : observedAt,
    alive,
    origin: { x: 0, y: 100, z: 0, dimension: 0 },
    position: { x: 1, y: 100, z: 0, dimension: 0 },
    items: { byCode: [] },
  });
  reporter.publish('run', run('before', 2000, false));
  reporter.publish('run', run('after', 3000, true));
  for (let index = 0; index < 30; index++) reporter.publish('event', { type: 'message', text: 'x'.repeat(512), index });
  await reporter.flush();
  reporter.close();
  assert.equal(JSON.stringify(report).length <= 4096, true);
  assert.deepEqual(
    report.log.filter(entry => entry.topic === 'run').map(entry => [entry.data.segmentId, entry.data.alive]),
    [
      ['before', false],
      ['after', true],
    ],
  );
});
