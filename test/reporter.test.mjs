import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Reporter } from '../src/runtime/reporter.mjs';

test('fleet reporter merges surface sweeps into one bounded map delta', async () => {
  let report;
  const reporter = new Reporter({ url: 'https://fleet.test', token: 'token', id: 'Atlas', intervalMs: 60000,
    mapColumns: 3, fetch: async (_url, request) => { report = JSON.parse(request.body); return new Response(null, { status: 204 }); } });
  reporter.publish('map', { columns: [[0, 0, 4, 'ground', 1, 'soil', 1, 0x112233], [1, 0, 4, 'ground', 1, 'grass', 1, 0x223344]] });
  reporter.publish('map', { columns: [[0, 0, 5, 'ground', 1, 'stone', 2, 0x334455], [2, 0, 4, 'water', 1, 'water', 2, 0x445566],
    [3, 0, 4, 'ground', 1, 'sand', 2, 0x556677]] });
  await reporter.flush(); reporter.close();
  assert.deepEqual(report.topics.map.data.columns, [
    [0, 0, 5, 'ground', 1, 'stone', 2, 0x334455], [2, 0, 4, 'water', 1, 'water', 2, 0x445566],
    [3, 0, 4, 'ground', 1, 'sand', 2, 0x556677],
  ]);
});

test('fleet reporter keeps goal intent and subgoal but omits executable source', async () => {
  let report;
  const reporter = new Reporter({ url: 'https://fleet.test', token: 'token', id: 'Kiln', intervalMs: 60000,
    fetch: async (_url, request) => { report = JSON.parse(request.body); return new Response(null, { status: 204 }); } });
  reporter.publish('goal', { id: 'goal-1', kind: 'goal_script', intent: 'Bring provisions home', active: true, state: 'running',
    args: { intent: 'Bring provisions home', goalScript: 'await goals.forage({ count: 32 });' },
    progress: { phase: 'running_goal', subgoal: { kind: 'forage', args: { count: 32 }, progress: { phase: 'harvesting' } } } });
  await reporter.flush(); reporter.close();
  assert.equal(report.topics.goal.data.intent, 'Bring provisions home');
  assert.deepEqual(report.topics.goal.data.args, { intent: 'Bring provisions home' });
  assert.equal(report.topics.goal.data.progress.subgoal.kind, 'forage');
  assert.equal(JSON.stringify(report).includes('goalScript'), false);
});
