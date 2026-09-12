import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gather } from '../src/goals/gather_sticks.ts';

function fixture({ gain = true, interruptAfter = Infinity } = {}) {
  const calls = [],
    reports = [];
  let walks = 0,
    scans = 0,
    inventory = 0,
    picked = false,
    target;
  const cancellation = new AbortController();
  const state = () => ({
    ok: true,
    capabilities: ['nearby_awareness'],
    player: { uid: 'bot' },
    alive: true,
    controlReady: true,
    position: { x: walks * 3, y: 0, z: 0.5, dimension: 0 },
    orientation: { yawDegrees: 90 },
    life: { session: 'world', lastDamageAt: null, alerts: ['low_food'] },
    motion: { onGround: true },
    body: { halfWidth: 0.3, height: 1.85 },
    hotbar: [{ code: 'game:stick', quantity: inventory }],
    backpack: [],
    target,
  });
  const env = {
    map: { cells: new Map(), stand: () => null },
    sync: async () => state(),
    aim: async () => {},
    report: p => reports.push(p),
    navigate: async () => {
      walks++;
      return { state: walks === 1 ? 'blocked' : 'arrived', reason: walks === 1 ? 'no_observed_route' : 'destination_reached' };
    },
    send: async request => {
      calls.push(request);
      if (request.action === 'observe') return state();
      if (request.action === 'scan') {
        scans++;
        if (scans >= interruptAfter) cancellation.abort();
        if (walks < 2)
          return {
            ok: true,
            objects: [{ kind: 'block', code: 'game:leaves-grown-birch', key: 'leaf', point: { x: 3, y: 2, z: 0.5 }, withinPickingRange: true }],
          };
        target = { key: `stick:${scans}`, code: 'game:loosestick-free' };
        return {
          ok: true,
          objects: [
            {
              ...target,
              kind: 'block',
              point: { x: walks * 3, y: 0.1, z: 0.5 },
              withinPickingRange: true,
              look: { yawDegrees: 90, pitchDegrees: 30 },
            },
          ],
        };
      }
      if (request.action === 'interact') {
        picked = true;
        if (gain) inventory++;
        return { ok: true };
      }
      assert.equal(request.action, 'stop', 'only ground pickup and normal navigation allowed');
      return { ok: true };
    },
  };
  return { env, calls, reports, cancellation, picked: () => picked };
}

test('persistent ground-only goal reroutes and verifies ten inventory gains', async () => {
  const f = fixture();
  const result = await gather(f.env, { count: 10, manageFood: false, wait: async () => {} });
  assert.equal(result.ok, true);
  assert.equal(result.gained, 10);
  assert.equal(f.calls.filter(c => c.action === 'interact').length, 10);
  assert.ok(f.reports.some(p => p.phase === 'rerouting'));
  assert.equal(f.calls.at(-1).action, 'stop');
});

test('acknowledgements do not count as sticks; cancellation stops continued search', async () => {
  const f = fixture({ gain: false, interruptAfter: 16 });
  await assert.rejects(gather(f.env, { count: 10, manageFood: false, signal: f.cancellation.signal, wait: async () => {} }), /cancelled/);
  assert.equal(f.picked(), true);
  assert.ok(f.reports.every(p => p.gained === 0));
  assert.equal(f.calls.at(-1).action, 'stop');
});

test('being hurt is reported and the goal carries on; a life alert ends it', async () => {
  const f = fixture();
  const original = f.env.send;
  let observations = 0;
  f.env.send = async request => {
    const r: any = await original(request);
    if (request.action === 'observe' && ++observations > 2) r.life.lastDamageAt = 100;
    return r;
  };
  const result = await gather(f.env, { count: 2, manageFood: false, wait: async () => {} });
  assert.equal(result.ok, true);
  assert.ok(
    f.reports.some(p => p.phase === 'hurt'),
    'the hit is an event in the goal progress',
  );
  const g = fixture();
  const first = g.env.send;
  g.env.send = async request => {
    const r: any = await first(request);
    if (request.action === 'observe') r.life.alerts = ['low_health'];
    return r;
  };
  await assert.rejects(gather(g.env, { manageFood: false, wait: async () => {} }), /life/);
  assert.equal(g.picked(), false);
  assert.equal(g.calls.at(-1).action, 'stop');
});
