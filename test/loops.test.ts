import assert from 'node:assert/strict';
import { test } from 'node:test';
import { collectItem } from '../src/goals/collect_item.ts';
import { explore } from '../src/goals/explore.ts';
import { travel } from '../src/goals/travel.ts';
import { until } from '../src/support/fieldwork.ts';

// A scripted field: what each look and each read returns is a script, time is a counter, and
// every loop a goal runs against it must be bounded by what it watches, never by luck.
function scripted({ states = [{}], inventory = () => ({ inventories: [] }) }: any = {}) {
  let clock = 0,
    looks = 0;
  const field: any = {
    latest: { position: { x: 0, y: 64, z: 0, dimension: 0 }, body: { eyeHeight: 1.6 } },
    moved: 0,
    now: () => clock,
    wait: async (ms: number) => {
      clock += ms;
    },
    observe: async () => {
      looks++;
      return { ok: true, ...(states[Math.min(looks - 1, states.length - 1)] ?? {}), position: field.latest.position };
    },
    send: async (request: any) => (request.action === 'inventory' ? inventory() : { ok: true }),
    report: () => {},
    calls: { walks: 0, scans: 0 },
    get looks() {
      return looks;
    },
  };
  field.until = (condition, options) => until(field, condition, options);
  return field;
}

test('until ends on the first look that meets the condition and reports a miss at the deadline', async () => {
  const met = scripted({ states: [{ activeSlot: 0 }, { activeSlot: 0 }, { activeSlot: 3 }] });
  const hit = await until(met, state => state.activeSlot === 3, { timeoutMs: 2000, everyMs: 100 });
  assert.equal(hit.met, true);
  assert.equal(met.looks, 3);
  assert.equal(met.now(), 200);
  const missed = scripted({ states: [{ activeSlot: 0 }] });
  const miss = await until(missed, state => state.activeSlot === 3, { timeoutMs: 500, everyMs: 100 });
  assert.equal(miss.met, false);
  assert.equal(missed.now(), 500);
  assert.equal(missed.looks, 6);
  const read = scripted({ inventory: () => ({ n: 7 }) });
  const seen = await until(read, (_, contents) => contents.n === 7, { read: () => read.send({ action: 'inventory' }) });
  assert.equal(seen.read.n, 7);
});

test('exploration does not report success after a blocked leg with no movement', async () => {
  const position = { x: 0.5, y: 64, z: 0.5 };
  const field = {
    heading: 90,
    latest: { position },
    moved: 0,
    seen: new Map(),
    report: () => {},
    explore: () => ({ x: 48.5, y: 64, z: 0.5 }),
    walk: async () => ({ state: 'blocked', reason: 'no_observed_route' }),
    scan: async () => [],
  };

  const result = await explore(field, null, { legs: 1, heading: undefined });
  assert.deepEqual(result, {
    ok: false,
    goal: 'explore',
    reason: 'no_observed_route',
    legs: ['blocked'],
    moved: 0,
    position,
    heading: 90,
  });
});

test('travel ends with the walk reason after repeated routeless legs from the same spot', async () => {
  const position = { x: 0.5, y: 64, z: 0.5 };
  let walks = 0;
  const field: any = {
    latest: { position },
    moved: 0,
    now: () => 0,
    report: () => {},
    observe: async () => ({ position }),
    explore: () => ({ x: 48.5, y: 64, z: 0.5 }),
    walk: async () => {
      walks++;
      return { state: 'blocked', reason: 'no_observed_route' };
    },
  };
  const result = await travel(field, null, { x: 100.5, z: 0.5, arrivalRadius: 1 });
  assert.equal(result.ok, false);
  assert.equal('reason' in result ? result.reason : null, 'no_observed_route');
  assert.equal(walks, 4, 'the direct leg plus three identical detours end the trip instead of spinning to the clock');
});

test('travel does not fast-fail when the planner finds routes but the legs stall', async () => {
  const position = { x: 0.5, y: 64, z: 0.5 };
  let walks = 0;
  const field: any = {
    latest: { position },
    moved: 0,
    now: () => 0,
    report: () => {},
    observe: async () => ({ position }),
    explore: () => ({ x: 48.5, y: 64, z: 0.5 }),
    walk: async () => {
      if (++walks === 4) throw Error('past_fast_fail');
      return { state: 'blocked', reason: 'stalled' };
    },
  };
  await assert.rejects(travel(field, null, { x: 100.5, z: 0.5, arrivalRadius: 1 }), /past_fast_fail/);
});

test('a drop that is never picked up ends the goal after a bounded number of approaches', async () => {
  const drop = { key: 'entity:9', code: 'game:stick', kind: 'item', quantity: 1, point: { x: 3, y: 64, z: 0 } };
  const field = scripted();
  field.scan = async () => {
    field.calls.scans++;
    return [drop];
  };
  field.approach = () => ({ x: 2.5, y: 64, z: 0.5 });
  field.walk = async () => {
    field.calls.walks++;
    // Arrives beside the drop every time; the pack never gains it.
    field.latest.position = { x: 2.5, y: 64, z: 0.5, dimension: 0 };
    return { state: 'arrived' };
  };
  const result = await collectItem(field, { target: 'entity:9', expectedItem: 'game:stick' });
  assert.equal(result.ok, false);
  assert.equal('reason' in result ? result.reason : null, 'pickup_failed');
  assert.equal(field.calls.walks, 6);
  assert.ok(field.looks < 200, `looked ${field.looks} times`);
});

test('body recovery does not finish travel on a ledge above the death marker', async () => {
  const { retrieveBody } = await import('../src/goals/retrieve_body.ts');
  const position = { x: 0.5, y: 10, z: 0.5 };
  const field = {
    latest: { position },
    moved: 0,
    now: () => 0,
    report: () => {},
    observe: async () => ({ position }),
    send: async request => {
      assert.equal(request.action, 'map_waypoints');
      return { ok: true, waypoints: [{ guid: 'death', icon: 'gravestone', position: { ...position, y: 0 } }] };
    },
    walk: async target => {
      assert.equal(target.y, 0);
      assert.notEqual(target.horizontalOnly, true);
      throw Error('route_checked');
    },
  };
  await assert.rejects(retrieveBody(field, null, { guid: 'death' }), /route_checked/);
});

test('a surveyed low rough checkpoint cannot be reached on an upper ledge', async () => {
  const { Fieldwork } = await import('../src/support/fieldwork.ts');
  const { SurfaceMemory, nextLeg } = await import('../src/runtime/navigation/surface.ts');
  const { findRoute } = await import('../src/runtime/navigation/planner.ts');
  const surface = new SurfaceMemory();
  surface.apply({ columns: Array.from({ length: 21 }, (_, x) => [x, 0, Math.max(0, 10 - x), 'ground', 1]) });
  const position = { x: 0.5, y: 10, z: 0.5 };
  const target = Fieldwork.prototype.roughRoute.call(
    { env: { surface }, latest: { position }, places: { failed: () => 0 } },
    { x: 20.5, y: 0, z: 0.5 },
  );
  assert.equal(target.y, 0);
  const upperLedge = {
    nodeAt: () => position,
    moves: at => (at.x < 20.5 ? [{ node: { ...at, x: at.x + 1 }, cost: 1 }] : []),
    gapMoves: () => [],
  };
  assert.equal(nextLeg([position, { x: 10.5, y: 30, z: 0.5 }, { x: 20.5, y: 50, z: 0.5 }], position, { maxVertical: 32 })?.y, 30);
  assert.equal(findRoute(upperLedge, position, target, 0.3, 1.85, { partial: false }), null);
});
