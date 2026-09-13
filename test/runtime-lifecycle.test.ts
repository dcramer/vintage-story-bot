import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BrainLoop } from '../src/runtime/brain.ts';
import { Controller } from '../src/runtime/controller.ts';

const turn = () => new Promise<void>(resolve => setImmediate(resolve));

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
    const event = controller.events.read(0).events.find(event => event.type === 'goal_finished');
    assert.equal(event.ok, false);
    assert.equal(event.outcome, 'interrupted');
    await controller.close();
  });
}
