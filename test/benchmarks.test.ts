import assert from 'node:assert/strict';
import { readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { BENCHMARKS, summarizeRuns } from '../src/support/benchmarks.ts';
import { readRuns } from '../scripts/bench.ts';

test('benchmarks: every goal has an expected time or a documented null', () => {
  const goals = readdirSync('src/goals')
    .filter(f => f.endsWith('.ts'))
    .map(f => f.slice(0, -3));
  assert.ok(goals.length > 30);
  for (const goal of goals) {
    assert.ok(goal in BENCHMARKS, `${goal} has no benchmark`);
    assert.equal(typeof BENCHMARKS[goal].note, 'string', `${goal} has no provenance note`);
  }
});

test('benchmarks: slow and failing goals are flagged, single runs are not', () => {
  const verdicts = summarizeRuns(
    { knap: { expectedMs: 120000, note: 'seed' }, travel: { expectedMs: 120000, note: 'seed' } },
    [
      { kind: 'knap', ms: 278000, ok: false, reason: 'no_workable_voxels' },
      { kind: 'knap', ms: 300000, ok: false, reason: 'no_workable_voxels' },
      { kind: 'knap', ms: 50000, ok: true },
      { kind: 'travel', ms: 20000, ok: true },
    ],
  );
  const knap = verdicts.find(v => v.kind === 'knap')!;
  assert.deepEqual(knap.flags, ['failing', 'slow']);
  assert.equal(knap.p50Ms, 278000);
  assert.deepEqual(knap.topReasons, [['no_workable_voxels', 2]]);
  const travel = verdicts.find(v => v.kind === 'travel')!;
  assert.deepEqual(travel.flags, []);
});

test('benchmarks: unbenchmarked runs and unrunnable goals are reported, not flagged', () => {
  const verdicts = summarizeRuns({ wait: { expectedMs: null, note: 'duration is the request' } }, [
    { kind: 'wait', ms: 600000, ok: true },
    { kind: 'mystery', ms: 1000, ok: true },
  ]);
  assert.deepEqual(verdicts.find(v => v.kind === 'wait')!.flags, []);
  assert.deepEqual(verdicts.find(v => v.kind === 'mystery')!.flags, ['unbenchmarked']);
});

test('bench: goal_started pairs with goal_finished by goal id', () => {
  const path = join(tmpdir(), `bench-${Date.now()}.ndjson`);
  const at = (s: string) => `2026-09-15T00:00:${s}.000Z`;
  writeFileSync(
    path,
    [
      { at: at('00'), scope: 'event', event: 'goal_started', goal: 'a', kind: 'knap', by: 'brain' },
      { at: at('05'), scope: 'event', event: 'goal_started', goal: 'b', kind: 'travel', by: 'brain' },
      { at: at('10'), scope: 'event', event: 'goal_finished', goal: 'a', kind: 'knap', by: 'brain', ok: true },
      { at: at('20'), scope: 'event', event: 'goal_finished', goal: 'b', kind: 'travel', by: 'brain', ok: false, reason: 'no_progress' },
      { at: at('25'), scope: 'event', event: 'goal_started', goal: 'c', kind: 'eat', by: 'brain' },
      'not json',
    ]
      .map(l => (typeof l === 'string' ? l : JSON.stringify(l)))
      .join('\n'),
  );
  const { runs, unfinished } = readRuns([path]);
  assert.equal(unfinished, 1);
  assert.deepEqual(runs, [
    { kind: 'knap', ms: 10000, ok: true },
    { kind: 'travel', ms: 15000, ok: false, reason: 'no_progress' },
  ]);
});
