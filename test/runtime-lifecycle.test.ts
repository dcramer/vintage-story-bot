import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrainLoop } from '../src/runtime/brain.ts';
import { Controller, outcomeOf } from '../src/runtime/controller.ts';
import { GoalError } from '../src/runtime/failure.ts';
import { runGoalPlan } from '../src/runtime/goal-script.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

test('failure outcomes survive message changes and composed goal context', async () => {
  for (const message of ['Start grounded', 'The player needs solid footing']) {
    const controller = new Controller(async () => ({ ok: true }));
    await controller.launch('wait', {}, (record, started, signal) =>
      controller.runTask(
        async () => {
          await runGoalPlan([{ goal: { name: 'wait' }, args: {} }], async () => {
            throw new GoalError('start_unsupported', message);
          });
          return { ok: true };
        },
        {},
        record,
        started,
        signal,
      ),
    );
    await controller.last.done;
    assert.equal(controller.goalView().outcome, 'refused');
    assert.equal(controller.goalView().code, 'start_unsupported');
    assert.match(controller.goalView().reason, /Goal 1\/1 \(wait\) failed:/);
    await controller.close();
  }
  assert.equal(outcomeOf({ state: 'blocked', nav: { reason: 'no_observed_route' } }), 'no_progress');
  assert.equal(outcomeOf({ state: 'blocked', reason: 'deadline appears in an unrelated error' }), 'failed');
});

test('removing a brain during a reading does not deadlock or execute its decision', { timeout: 2000 }, async () => {
  const observation = Promise.withResolvers<any>();
  const sent: string[] = [];
  const controller = new Controller(async request => {
    sent.push(request.action);
    return request.action === 'observe' ? observation.promise : { ok: true };
  });
  let decisions = 0;
  const loop = new BrainLoop(controller, {
    name: 'test',
    description: 'test',
    fresh: () => ({}),
    decide: () => {
      decisions++;
      return { act: [{ action: 'chat', message: 'never sent' }], why: 'test' };
    },
  });
  controller.brain = loop;
  loop.start();
  const removal = controller.request({ action: 'brain', name: null });
  await turn();
  observation.resolve({ ok: true, alive: true, capabilities: [] });
  assert.equal((await removal).ok, true);
  assert.equal(decisions, 0);
  assert.equal(sent.includes('chat'), false);
  assert.equal((await controller.request({ action: 'inventory' })).ok, true);
  await controller.close();
});

test('removing a brain cancels an action already waiting for the request lock', { timeout: 2000 }, async () => {
  const held = Promise.withResolvers<void>();
  const sent: string[] = [];
  const controller = new Controller(async request => {
    sent.push(request.action);
    return { ok: true, alive: true, capabilities: [] };
  });
  const locked = controller.withLock(() => held.promise);
  const loop = new BrainLoop(controller, {
    name: 'test',
    description: 'test',
    fresh: () => ({}),
    decide: () => ({ act: [{ action: 'chat', message: 'never sent' }], why: 'test' }),
  });
  controller.brain = loop;
  loop.start();
  await turn();
  assert.equal(loop.lastDecision, 'act chat: test');
  const removal = controller.request({ action: 'brain', name: null });
  await turn();
  held.resolve();
  await locked;
  assert.equal((await removal).ok, true);
  assert.equal(sent.includes('chat'), false);
  await controller.close();
});

for (const ok of [false, true]) {
  test(`cancellation wins over a late goal result (ok=${ok})`, async () => {
    const result = Promise.withResolvers<any>();
    const controller = new Controller(async () => ({ ok: true }));
    await controller.launch('wait', {}, (record, started, signal) => controller.runTask(() => result.promise, {}, record, started, signal));
    const stopped = controller.stop();
    result.resolve({ ok, ...(ok ? {} : { reason: 'none_found' }) });
    await stopped;
    const view = controller.goalView();
    assert.equal(view.state, 'cancelled');
    assert.equal(view.outcome, 'interrupted');
    assert.equal(view.reason, 'stopped');
    assert.equal(view.active, false);
    assert.equal(view.result.ok, false, 'adapters reading only the result must also see cancellation');
    assert.equal(view.result.code, 'cancelled');
    assert.equal(view.result.outcome, 'interrupted');
    const event = controller.events.read(0).events.find(event => event.type === 'goal_finished');
    assert.equal(event.ok, false);
    assert.equal(event.outcome, 'interrupted');
    await controller.close();
  });
}
