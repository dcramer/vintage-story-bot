import assert from 'node:assert/strict';
import { test } from 'node:test';
import { gather } from '../src/goals/gather.ts';
import { blockWorkReady, dryBlockWorkPosition } from '../src/support/blocks.ts';

test('block work requires dry ground and rejects wet approach cells', () => {
  assert.equal(blockWorkReady({ motion: { onGround: true } }), true);
  assert.equal(blockWorkReady({ motion: { onGround: true, feetInLiquid: true } }), false);
  assert.equal(blockWorkReady({ motion: { onGround: false, swimming: true } }), false);
  assert.equal(dryBlockWorkPosition({ x: 0, y: 0, z: 0 }), true);
  assert.equal(dryBlockWorkPosition({ x: 0, y: 0, z: 0, wet: true }), false);
  assert.equal(dryBlockWorkPosition({ x: 0, y: 0, z: 0, swim: true }), false);
});

function fixture({ gain = true, interruptAfter = Infinity } = {}) {
  const calls = [],
    reports = [];
  let walks = 0,
    scans = 0,
    sweeps = 0,
    inventory = 0,
    picked = false,
    target;
  const cancellation = new AbortController();
  const state = () => ({
    ok: true,
    capabilities: ['nearby_awareness', 'block_sightings'],
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
  // What the eye has seen, as memory answers a goal's look: leaves until the
  // second walk, then a loose stick in reach.
  const view = () => {
    scans++;
    if (scans >= interruptAfter) cancellation.abort();
    if (walks < 2) return [{ kind: 'block', code: 'game:leaves-grown-birch', key: 'leaf', point: { x: 3, y: 2, z: 0.5 }, withinPickingRange: true }];
    target = { key: `stick:${scans}`, code: 'game:loosestick-free' };
    return [
      { ...target, kind: 'block', point: { x: walks * 3, y: 0.1, z: 0.5 }, withinPickingRange: true, look: { yawDegrees: 90, pitchDegrees: 30 } },
    ];
  };
  const env = {
    map: { cells: new Map(), stand: () => null },
    sightings: { view: (_eye, options) => (options?.remembered ? [] : view()), skip: () => {}, forget: () => {} },
    surface: {
      get sweeps() {
        return ++sweeps;
      },
    },
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

test('being hurt is reported and the goal carries on; death ends it', async () => {
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
    if (request.action === 'observe') r.alive = false;
    return r;
  };
  await assert.rejects(gather(g.env, { manageFood: false, wait: async () => {} }), /life/);
  assert.equal(g.picked(), false);
  assert.equal(g.calls.at(-1).action, 'stop');
});
