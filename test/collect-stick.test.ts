import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectStick } from '../src/goals/collect_stick.ts';

function fixture({ stale = false, gained = 1, reachable = true, damage = false, low = false } = {}) {
  const calls = [];
  let observations = 0;
  const target = { key: 'stick:1', code: 'game:loosestick-free', withinPickingRange: reachable, look: { yawDegrees: 90, pitchDegrees: 30 } };
  const send = async request => {
    calls.push(request);
    if (request.action === 'scan') return { ok: true, objects: [target] };
    if (request.action === 'observe') {
      observations++;
      return {
        ok: true,
        capabilities: ['target_guard', 'life_events'],
        alive: true,
        paused: false,
        mouseGrabbed: true,
        life: { session: 'test', lastDamageAt: damage && observations >= 2 ? 123 : null, alerts: low ? ['low_food'] : [] },
        player: { uid: 'bot' },
        hotbar: observations >= 3 ? [{ code: 'game:stick', quantity: gained }] : [],
        backpack: [],
        target: observations === 2 ? { key: stale ? 'different' : target.key } : null,
      };
    }
    return { ok: true };
  };
  return { send, calls };
}

test('reachable-stick goal verifies inventory delta and releases inputs', async () => {
  const { send, calls } = fixture();
  assert.equal((await collectStick(send, async () => {})).gained, 1);
  assert.deepEqual(
    calls.find(call => call.action === 'interact'),
    { action: 'interact', durationMs: 250, expectedTarget: 'stick:1' },
  );
  assert.equal(calls.at(-1).action, 'stop');
});

test('danger interrupts the goal before pickup and low vitals prevent starting', async () => {
  for (const options of [{ damage: true }, { low: true }]) {
    const { send, calls } = fixture(options);
    await assert.rejects(collectStick(send, async () => {}));
    assert.equal(
      calls.some(call => call.action === 'interact'),
      false,
    );
    if (options.damage) assert.equal(calls.at(-1).action, 'stop');
  }
});

test('stale/unreachable targets never trigger pickup', async () => {
  for (const options of [{ stale: true }, { reachable: false }]) {
    const { send, calls } = fixture(options);
    await assert.rejects(collectStick(send, async () => {}));
    assert.equal(
      calls.some(call => call.action === 'interact'),
      false,
    );
  }
});

test('acknowledgement without inventory gain is not success and is not retried', async () => {
  const { send, calls } = fixture({ gained: 0 });
  await assert.rejects(
    collectStick(send, async () => {}),
    /not verified/,
  );
  assert.equal(calls.filter(call => call.action === 'interact').length, 1);
  assert.equal(calls.at(-1).action, 'stop');
});
