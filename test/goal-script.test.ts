import assert from 'node:assert/strict';
import { test } from 'node:test';
import { z } from 'zod';
import { Controller } from '../src/runtime/controller.ts';
import { compileGoalScript, parseGoalScript, runGoalPlan } from '../src/runtime/goal-script.ts';

const definitions = [
  { name: 'forage', schema: z.object({ count: z.number().int().min(1).default(1), timeoutMs: z.number().optional() }).strict(), run() {} },
  { name: 'travel', schema: z.object({ x: z.number(), z: z.number() }).strict(), compose() {} },
  { name: 'goal_script', schema: z.object({}).strict(), run() {} },
];

test('goal scripts compile a TypeScript-compatible chain through existing goal schemas', () => {
  const plan = compileGoalScript(`async () => {
    // Build a reserve before leaving.
    await goals.forage({ count: 32, });
    await goals.travel({ x: -181, z: 524 });
  }`, definitions);
  assert.deepEqual(plan.map(step => [step.goal.name, step.args]), [
    ['forage', { count: 32 }], ['travel', { x: -181, z: 524 }],
  ]);
});

test('goal scripts reject arbitrary code, dynamic arguments and recursive composition', () => {
  for (const source of [
    'process.exit();',
    'const target = { x: 1, z: 2 }; await goals.travel(target);',
    'while (true) await goals.forage({});',
    'await goals.travel({ x: await fetch("https://example.com"), z: 2 });',
    'await goals["travel"]({ x: 1, z: 2 });',
  ]) assert.throws(() => parseGoalScript(source));
  assert.throws(() => compileGoalScript('await goals.goal_script({});', definitions), /not an existing composable goal/);
  assert.throws(() => compileGoalScript('await goals.travel({ x: 1 });', definitions), /invalid arguments/);
  assert.throws(() => compileGoalScript('await goals.forage({ count: 8, timeoutMs: 60000 });', definitions), /cannot set a deadline/);
});

test('goal plans run in order, nest progress and stop at the first failure', async () => {
  const plan = compileGoalScript('await goals.forage({ count: 2 }); await goals.travel({ x: 1, z: 2 });', definitions);
  const calls = [], reports = [];
  await assert.rejects(runGoalPlan(plan, async (step, report) => {
    calls.push(step.goal.name); report({ phase: 'working', gained: 1 });
    return step.goal.name === 'forage' ? { ok: true } : { ok: false, reason: 'blocked trail' };
  }, progress => reports.push(progress)), /Goal 2\/2 \(travel\) failed: blocked trail/);
  assert.deepEqual(calls, ['forage', 'travel']);
  assert.equal(reports.find(row => row.subgoal?.progress)?.subgoal.progress.phase, 'working');
  assert.equal(reports.find(row => row.phase === 'goal_completed')?.completed, 1);
});

test('controller retains high-level intent and source in the outer goal record', async () => {
  const controller = new Controller(async () => ({ ok: true }));
  const request = { action: 'goal_script', intent: 'Bring provisions home',
    goalScript: 'await goals.travel({ waypoint: "missing" });' };
  const started = await controller.request(request);
  assert.equal(started.ok, true);
  for (let index = 0; controller.active && index < 100; index++) await new Promise(resolve => setTimeout(resolve, 5));
  const status = await controller.request({ action: 'goal_status', id: started.goal.id });
  assert.equal(status.goal.intent, request.intent);
  assert.deepEqual(status.goal.args, { intent: request.intent, goalScript: request.goalScript });
  assert.equal(status.goal.state, 'blocked');
  assert.match(status.goal.reason, /Goal 1\/1 \(travel\) failed: Unknown waypoint/);
  await controller.close();
});
