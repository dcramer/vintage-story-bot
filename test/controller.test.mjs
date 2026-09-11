import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller/runtime.mjs';
import { Navigation } from '../src/navigation/navigator.mjs';
import { horizontal, TerrainMemory } from '../src/navigation/terrain.mjs';
import { findRoute } from '../src/navigation/planner.mjs';

function terrain() {
  const cells = [];
  for (let x = -3; x <= 4; x++) for (let z = -3; z <= 3; z++) for (let y = -2; y <= 4; y++)
    cells.push([x, y, z, 0, false, y < 0 ? [[0, 0, 0, 1, 1, 1]] : []]);
  return { session: 'terrain', reset: false, cursor: 1, more: false, clock: 0, cells };
}
const target = { action: 'move_to', x: 2.5, y: 0, z: .5, dimension: 0 };
function fixture(failFrame = false) {
  const calls = [], state = { ok: true, capabilities: [], player: { uid: 'bot' }, position: { x: .5, y: 0, z: .5, dimension: 0 },
    controlReady: true, alive: true, motion: { onGround: true }, life: { session: 'life', alerts: [], lastDamageAt: null },
    control: { epoch: 1, owner: null }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 }, orientation: { yawDegrees: 90, pitchDegrees: 20 } };
  let resolveFrame;
  const frame = new Promise(resolve => { resolveFrame = resolve; });
  const send = async request => {
    calls.push(request);
    if (request.action === 'sense') return { ok: true, state: structuredClone(state), terrain: terrain() };
    if (request.action === 'control_begin') state.control.owner = request.owner;
    if (request.action === 'control_end' || request.action === 'stop') state.control.owner = null;
    if (request.action === 'control_step') {
      resolveFrame();
      if (failFrame) throw Error('lost acknowledgement');
      return { ok: true, state: structuredClone(state), terrain: terrain() };
    }
    return { ok: true };
  };
  return { controller: new Controller(send), calls, frame, state };
}

test('Node geometry preserves step, headroom and hole constraints', () => {
  const map = new TerrainMemory(); map.apply(terrain());
  const start = { x: .5, y: 0, z: .5 }, end = { x: 2.5, y: 0, z: .5 };
  const direct = findRoute(map, start, end, .3, 1.85);
  assert.ok(direct);
  assert.equal(direct[0].x, 1.5, 'safe planning anchor is not a physical checkpoint');
  map.apply({ ...terrain(), cells: [[1, 0, 0, 0, false, [[0, 0, 0, 1, 1, 1]]]] });
  assert.ok(map.traverse(start, { x: 1.5, y: 1, z: .5 }, .3, 1.85));
  map.apply({ ...terrain(), cells: [[1, 2, 0, 0, false, [[0, 0, 0, 1, 1, 1]]]] });
  assert.equal(map.traverse(start, { x: 1.5, y: 1, z: .5 }, .3, 1.85), false);
  map.apply({ ...terrain(), reset: true });
  map.apply({ ...terrain(), cells: [[1, -1, 0, 0, false, []], [1, -2, 0, 0, false, []]] });
  assert.equal(map.traverse(start, end, .3, 1.85), false);
  assert.ok(findRoute(map, start, end, .3, 1.85).some(p => p.z !== .5));
  map.apply({ ...terrain(), cells: [[0, 0, 0, 0, false, null]] });
  assert.equal(map.clear(start, .3, 1.85), false);
});

test('planner crosses only a fully observed dry one-cell gap', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -1; x <= 4; x++) for (let z = -1; z <= 3; z++) for (let y = -3; y <= 3; y++) {
    const support = y === -1 && x !== 1;
    cells.push([x, y, z, 0, false, support ? [[0, 0, 0, 1, 1, 1]] : []]);
  }
  map.apply({ session: 'gap', reset: true, cursor: 1, more: false, clock: 0, cells });
  const start = { x: .5, y: 0, z: .5 }, landing = { x: 2.5, y: 0, z: .5 };
  assert.equal(map.traverse(start, landing, .3, 1.85), false);
  assert.equal(map.jumpTraverse(start, landing, .3, 1.85), true);
  assert.equal(map.jumpTraverse(start, { x: 3.5, y: 0, z: .5 }, .3, 1.85), true);
  assert.equal(map.jumpTraverse(start, { x: 2.5, y: 0, z: 2.5 }, .3, 1.85), true);
  assert.equal(map.jumpTraverse(start, { x: 3.61, y: 0, z: .5 }, .3, 1.85), false);
  const route = findRoute(map, start, { x: 3.5, y: 0, z: .5 }, .3, 1.85, { partial: false });
  assert.equal(route[0].jumpGap, true);
  assert.equal(route[0].x, landing.x);
  map.apply({ session: 'gap', reset: false, cursor: 2, more: false, clock: 1,
    cells: [[1, -2, 0, 1, true, []]] });
  assert.equal(map.jumpTraverse(start, landing, .3, 1.85), false);
});

test('navigation holds a validated gap jump until airborne', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, dry: () => true,
    traverse: () => true, jumpTraverse: () => true, views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 3.5, y: 0, z: .5, jumpGap: true }]; nav.edgeStart = state.position;
  const first = nav.tick(state, 100);
  assert.equal(first.jump, true);
  assert.equal(first.sprint, true);
  assert.equal(nav.tick(state, 250).jump, true, 'a slow first frame must not look like a landing');
  const airborne = { ...state, position: { x: 1.2, y: .4, z: .5 }, motion: { onGround: false } };
  assert.equal(nav.tick(airborne, 350).forward, true);
  assert.equal(nav.airborneDuringJump, true);
});

test('planner reuses an observed route beyond 32 blocks', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -1; x <= 50; x++) for (let z = -1; z <= 1; z++) for (let y = -1; y <= 2; y++)
    cells.push([x, y, z, 0, false, y < 0 ? [[0, 0, 0, 1, 1, 1]] : []]);
  map.apply({ session: 'long-route', reset: true, cursor: 1, more: false, clock: 0, cells });
  const start = { x: .5, y: 0, z: .5 }, end = { x: 48.5, y: 0, z: .5 };
  const route = findRoute(map, start, end, .3, 1.85, { budget: 128 });
  assert.ok(route);
  assert.equal(route.at(-1).x, end.x);
  assert.equal(route.at(-1).z, end.z);
});

test('planner escapes a returning point whose hazard margin spans adjacent cells', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -9; x <= 10; x++) for (let z = -9; z <= 9; z++) for (let y = -2; y <= 2; y++)
    cells.push([x, y, z, 0, Math.abs(x) <= 4 && y === -2 && Math.abs(z) <= 4,
      y === -1 ? [[0, 0, 0, 1, 1, 1]] : []]);
  map.apply({ session: 'wide-margin', reset: true, cursor: 1, more: false, clock: 0, cells });
  const start = { x: .5, y: 0, z: .5 }, end = { x: 8.5, y: 0, z: .5 };
  assert.equal(map.dry(start, .3, 1.85), false);
  assert.equal(map.stand(4.5, .5, 0, .3, 1.85), null);
  const nav = new Navigation(map, { position: start, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [] }, { ...end, timeoutMs: 60000 }, 0);
  assert.ok(nav.tick({ position: start, motion: { onGround: true }, orientation: { yawDegrees: 0 },
    vitals: { hunger: { current: 1000, max: 1500 } }, nearbyEntities: [] }, 1));
  assert.equal(nav.state, 'moving');
  assert.equal(nav.replans, 0);
  let at = start;
  for (let step = 0; step < 8 && !map.dry(at, .3, 1.85); step++) {
    const route = findRoute(map, at, end, .3, 1.85);
    assert.ok(route);
    assert.ok(Math.hypot(route[0].x - at.x, route[0].z - at.z) >= .75);
    assert.ok(map.hazardDistance(route[0], 1.85) > map.hazardDistance(at, 1.85));
    at = route[0];
  }
  assert.equal(map.dry(at, .3, 1.85), true);
});

test('terrain permits supported recentering off thin partial ground cover', () => {
  const map = new TerrainMemory();
  const cells = [];
  for (let x = -1; x <= 2; x++) for (let y = -1; y <= 3; y++) for (let z = -1; z <= 2; z++)
    cells.push([x, y, z, 0, false, []]);
  cells.push([0, 1, 0, 0, false, [[0, 0, 0, .5, .0625, 1]]]);
  cells.push([1, 0, 0, 0, false, [[0, 0, 0, 1, 1, 1]]]);
  map.apply({ session: 'thin', reset: true, cursor: 1, clock: 0, cells });
  const start = { x: .4, y: 1.0625, z: .5 }, safe = { x: 1.5, y: 1, z: .5 };
  assert.ok(map.support(start, .3) > 0 && map.support(start, .3) < 9);
  assert.equal(map.traverse(start, safe, .3, 1.85, false), false);
  assert.equal(map.traverse(start, safe, .3, 1.85, true), true);
  const edge = { x: .9, y: 1.0625, z: .5 };
  assert.deepEqual(findRoute(map, edge, { x: 4.5, y: 1, z: .5 }, .3, 1.85), [{ ...safe, recenter: true }]);
});

test('planner preserves a precise recenter anchor on a longer route', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -1; x <= 5; x++) for (let y = -1; y <= 3; y++) for (let z = -1; z <= 1; z++)
    cells.push([x, y, z, 0, false, []]);
  cells.push([0, 1, 0, 0, false, [[0, 0, 0, .5, .0625, 1]]]);
  for (let x = 1; x <= 5; x++) cells.push([x, 0, 0, 0, false, [[0, 0, 0, 1, 1, 1]]]);
  map.apply({ session: 'thin-long', reset: true, cursor: 1, clock: 0, cells });
  const edge = { x: .9, y: 1.0625, z: .5 }, safe = { x: 1.5, y: 1, z: .5 };
  const route = findRoute(map, edge, { x: 4.5, y: 1, z: .5 }, .3, 1.85);
  assert.ok(route.length > 1);
  assert.deepEqual(route[0], { ...safe, recenter: true });
});

test('evasion permits a mandatory short recenter before increasing clearance', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -1; x <= 5; x++) for (let y = -1; y <= 3; y++) for (let z = -1; z <= 1; z++)
    cells.push([x, y, z, 0, false, []]);
  cells.push([0, 1, 0, 0, false, [[0, 0, 0, .5, .0625, 1]]]);
  for (let x = 1; x <= 5; x++) cells.push([x, 0, 0, 0, false, [[0, 0, 0, 1, 1, 1]]]);
  map.apply({ session: 'thin-evade', reset: true, cursor: 1, clock: 0, cells });
  const position = { x: .9, y: 1.0625, z: .5 };
  const state = { position, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [{ key: 'entity:1', code: 'game:wolf-male', point: { x: 10.5, y: 1, z: .5 } }] };
  const nav = new Navigation(map, state, { x: -5.5, y: 1, z: .5, timeoutMs: 10000 }, 0);
  const frame = nav.tick(state, 1);
  assert.equal(nav.state, 'moving');
  assert.equal(nav.nextCheckpoint.recenter, true);
  assert.equal(frame.forward, true);
});

test('terrain keeps planned standing centers clear of adjacent liquid hazards', () => {
  const map = new TerrainMemory();
  const cells = [];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) {
    cells.push([x, -1, z, 0, false, []]);
    cells.push([x, 0, z, 0, false, [[0, 0, 0, 1, 1, 1]]]);
    cells.push([x, 1, z, 0, z === 1, []]);
    cells.push([x, 2, z, 0, false, []]);
  }
  map.apply({ session: 'shore', reset: true, cursor: 1, clock: 0, cells });
  assert.equal(map.stand(.5, -.5, 1, .3, 1.85)?.y, 1);
  assert.equal(map.stand(.5, 0.5, 1, .3, 1.85), null);
  const margin = { x: .5, y: 1, z: .5 }, safe = { x: .5, y: 1, z: -.5 };
  assert.equal(map.clear(margin, .3, 1.85), true);
  assert.equal(map.dry(margin, .3, 1.85), false);
  assert.equal(map.traverse(margin, safe, .3, 1.85, true), true, 'dry player can leave a hazard margin');
  assert.equal(map.traverse(safe, margin, .3, 1.85, true), false, 'safe route cannot enter a hazard margin');

  const deep = [];
  for (let x = -2; x <= 2; x++) for (let z = -2; z <= 2; z++) for (let y = -2; y <= 3; y++) {
    const water = z === 1 && y === -1;
    const ground = z === 1 ? y === -2 : y === 0;
    deep.push([x, y, z, 0, water, ground ? [[0, 0, 0, 1, 1, 1]] : []]);
  }
  map.apply({ session: 'deep-shore', reset: true, cursor: 1, clock: 0, cells: deep });
  assert.equal(map.stand(.5, .5, 1, .3, 1.85), null, 'water below a nearby ledge is unsafe');
  assert.equal(map.stand(.5, -.5, 1, .3, 1.85)?.y, 1, 'dry ground outside the margin remains usable');
});

test('a descent requires its exposed lower hazard margin to be observed', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -2; x <= 3; x++) for (let z = -2; z <= 2; z++) for (let y = -2; y <= 3; y++) {
    const support = x <= 0 && y === 0 || x >= 1 && y === -1;
    cells.push([x, y, z, 0, false, support ? [[0, 0, 0, 1, 1, 1]] : []]);
  }
  map.apply({ session: 'descent-margin', reset: true, cursor: 1, more: false, clock: 0, cells });
  const upper = { x: .5, y: 1, z: .5 }, lower = { x: 1.5, y: 0, z: .5 };
  assert.equal(map.traverse(upper, lower, .3, 1.85), true);
  // Sealed under the known solid support: unobservable by any sightline, harmless.
  map.apply({ session: 'descent-margin', reset: false, cursor: 2, more: false, clock: 1,
    cells: [[1, -2, 0, 1, false, null]] });
  assert.equal(map.traverse(upper, lower, .3, 1.85), true);
  // The support cell itself unknown, with air above it: exposed, must be seen.
  map.apply({ session: 'descent-margin', reset: false, cursor: 3, more: false, clock: 1,
    cells: [[2, -1, 0, 1, false, null]] });
  assert.equal(map.traverse(upper, lower, .3, 1.85), false);
});

test('terrain permits only fully observed dry two-block descents', () => {
  const map = new TerrainMemory(), cells = [];
  for (let x = -2; x <= 3; x++) for (let z = -2; z <= 2; z++) for (let y = -4; y <= 3; y++) {
    const support = x <= 0 && y === 0 || x >= 1 && y === -2;
    cells.push([x, y, z, 0, false, support ? [[0, 0, 0, 1, 1, 1]] : []]);
  }
  map.apply({ session: 'two-block-descent', reset: true, cursor: 1, more: false, clock: 0, cells });
  const upper = { x: .5, y: 1, z: .5 }, lower = { x: 1.5, y: -1, z: .5 };
  assert.equal(map.stand(1.5, .5, upper.y, .3, 1.85)?.y, -1);
  assert.equal(map.traverse(upper, lower, .3, 1.85), true);
  assert.ok(findRoute(map, upper, lower, .3, 1.85));
  // Cells sealed under the known solid landing can never be seen and do not
  // block the descent; an exposed unknown cell beside the landing still does.
  const buried = [];
  for (let x = 1; x <= 3; x++) for (let z = -2; z <= 2; z++) for (let y = -4; y <= -3; y++) buried.push([x, y, z, 1, false, null]);
  map.apply({ session: 'two-block-descent', reset: false, cursor: 2, more: false, clock: 1, cells: buried });
  assert.equal(map.traverse(upper, lower, .3, 1.85), true);
  map.apply({ session: 'two-block-descent', reset: false, cursor: 3, more: false, clock: 1,
    cells: [[2, -2, 0, 1, false, []], [2, -3, 0, 1, false, null]] });
  assert.equal(map.traverse(upper, lower, .3, 1.85), false);
  map.apply({ session: 'two-block-descent', reset: false, cursor: 4, more: false, clock: 1,
    cells: [[2, -2, 0, 1, false, [[0, 0, 0, 1, 1, 1]]], [1, -3, 0, 1, true, []]] });
  assert.equal(map.traverse(upper, lower, .3, 1.85), false);
});

test('navigation tolerates slow physical response without unbounded input', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.progressAt = 0; nav.lastProgress = state.position;
  assert.equal(nav.tick(state, 2000).forward, true);
  assert.equal(nav.replans, 0);
  assert.equal(nav.tick(state, 3100), null);
  assert.equal(nav.replans, 1);
  assert.equal(nav.lastReplan, 'stuck');
});

test('navigation counts camera convergence as bounded progress', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.progressAt = 0; nav.lastProgress = state.position;
  const first = nav.tick(state, 2000);
  assert.equal(first.forward, false);
  assert.equal(first.yawDegrees, 90);
  assert.equal(nav.tick({ ...state, orientation: { yawDegrees: 30 } }, 4000).forward, false);
  assert.equal(nav.replans, 0);
  assert.equal(nav.progressAt, 4000);
});

test('navigation accepts a bounded checkpoint crossing between slow samples', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    views: () => new Map() };
  const initial = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, initial, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.edgeStart = initial.position;
  const sampled = { ...initial, position: { x: 3, y: 0, z: .5 } };
  assert.equal(nav.tick(sampled, 500), null);
  assert.equal(nav.index, 1);
  assert.equal(nav.segments, 1);
  assert.equal(nav.state, 'surveying');
});

test('navigation preserves recentering when look-ahead advances the route index', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, dry: () => true,
    traverse: (_from, _to, _w, _h, recenter) => recenter, views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: .5, timeoutMs: 60000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }, { x: 2.5, y: 0, z: .5 }]; nav.index = 0;
  const frame = nav.tick(state, 1);
  assert.ok(frame);
  assert.equal(nav.index, 1);
  assert.equal(nav.state, 'moving');
  assert.equal(nav.replans, 0);
});

test('navigation preserves recentering after crossing an intermediate checkpoint', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, dry: () => true,
    traverse: (_from, _to, _w, _h, recenter) => recenter, views: () => new Map() };
  const initial = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [] };
  const nav = new Navigation(map, initial, { x: 3.5, y: 0, z: .5, timeoutMs: 60000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }, { x: 2.5, y: 0, z: .5 }]; nav.index = 0;
  const state = { ...initial, position: { x: 1.6, y: 0, z: .6 } };
  const frame = nav.tick(state, 1);
  assert.ok(frame);
  assert.equal(nav.index, 1);
  assert.equal(nav.state, 'moving');
  assert.equal(nav.replans, 0);
});

test('navigation takes short frames through a nearby sharp checkpoint without crouching', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: (_, to) => to.z === .5,
    views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: 4.5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }, { x: 1.5, y: 0, z: 1.5 }];
  const frame = nav.tick(state, 500);
  assert.equal(frame.forward, true);
  assert.equal(frame.sneak, false);
  assert.equal(frame.durationMs, 180);
});

test('navigation walks a validated descent without crouching and releases forward while airborne', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    views: () => new Map() };
  const state = { position: { x: .5, y: 1, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.edgeStart = state.position;
  const frame = nav.tick(state, 500);
  assert.equal(frame.forward, true);
  assert.equal(frame.sneak, false);
  assert.equal(frame.durationMs, 180);
  const edge = { ...state, position: { x: 1.1, y: 1, z: .5 } };
  assert.equal(nav.tick(edge, 600).sneak, false);
  const airborne = { ...edge, position: { x: 1.2, y: .8, z: .5 }, motion: { onGround: false } };
  assert.equal(nav.tick(airborne, 700).forward, false);
});

test('navigation keeps recentering safely from partial edge support', () => {
  const traversals = [];
  const map = { cells: new Map(), support: () => 9, clear: () => true,
    traverse: (_, __, ___, ____, recenter) => (traversals.push(recenter), recenter), views: () => new Map() };
  const state = { position: { x: .9, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 75 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.edgeStart = state.position;
  const frame = nav.tick(state, 500);
  assert.equal(frame.forward, true);
  assert.deepEqual(traversals, [true, true]);
});

test('navigation does not cross or loosely finish a precise recenter checkpoint', () => {
  const map = { cells: new Map(), support: p => p.z > .4 && p.z < .6 ? 9 : 3, clear: () => true,
    dry: () => true, traverse: () => true, views: () => new Map() };
  const initial = { position: { x: .5, y: 0, z: .15 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [] };
  const nav = new Navigation(map, initial, { x: .5, y: 0, z: 8.5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: .5, y: 0, z: .5, recenter: true }]; nav.edgeStart = initial.position;
  assert.ok(nav.tick(initial, 100));
  assert.equal(nav.index, 0);
  const near = { ...initial, position: { x: .5, y: 0, z: .45 } };
  nav.tick(near, 200);
  assert.equal(nav.index, 1);
});

test('navigation temporarily routes away from an explicit nearby hostile', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    stand: (x, z, y) => ({ x, y, z }), frontier: () => new Map(), views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [{ key: 'entity:1', code: 'game:wolf-male', point: { x: -.5, y: 0, z: .5 } }] };
  const goal = { x: 5.5, y: 0, z: .5, timeoutMs: 10000 };
  const distant = { ...state, nearbyEntities: [{ ...state.nearbyEntities[0], point: { x: -28.5, y: 0, z: .5 } }] };
  const calm = new Navigation(map, distant, goal, 0);
  calm.tick(distant, 0);
  assert.equal(calm.evading, false);
  const nav = new Navigation(map, state, goal, 0);
  assert.ok(nav.tick(state, 0));
  assert.equal(nav.evading, true);
  assert.ok(nav.target.x > goal.x && nav.target.emergency);
  nav.tick(distant, 1);
  assert.equal(nav.evading, true);
  nav.tick({ ...state, nearbyEntities: [{ ...state.nearbyEntities[0], point: { x: -36.5, y: 0, z: .5 } }] }, 2);
  assert.equal(nav.evading, false);
  assert.equal(nav.target, goal);
});

test('evasion route does not approach another visible hostile', () => {
  const map = new TerrainMemory(); map.apply(terrain());
  const start = { x: .5, y: 0, z: .5 };
  const west = { key: 'entity:1', code: 'game:wolf-male', point: { x: -1.5, y: 0, z: .5 } };
  const east = { key: 'entity:2', code: 'game:bowtorn-surface', point: { x: 2.5, y: 0, z: .5 } };
  const state = { position: start, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [west, east] };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  assert.ok(nav.tick(state, 0));
  assert.equal(nav.evading, true);
  assert.equal(nav.threats.length, 2);
  assert.ok(nav.route.length);
  assert.ok(nav.route.every(point => horizontal(point, west.point) >= 1.5));
  assert.ok(nav.route.every(point => horizontal(point, east.point) >= 1.5));
});

test('shared controller excludes mutations/UI and Effect interruption releases its owner', async () => {
  const { controller, calls, frame } = fixture();
  const result = await controller.request(target);
  assert.equal(result.ok, true); await frame;
  assert.equal((await controller.request({ action: 'stop', expectedGoal: '00000000-0000-4000-8000-000000000000' })).ok, false);
  assert.ok(controller.active);
  await assert.rejects(controller.request({ action: 'move', durationMs: 250 }), /Goal active/);
  await assert.rejects(controller.request({ action: 'ui_screenshot' }), /Unknown controller action/);
  await controller.close();
  assert.equal(controller.active, null);
  assert.equal(controller.view().state, 'cancelled');
  assert.equal(calls.filter(c => c.action === 'control_end').length, 1);
  assert.equal(calls.at(-1).owner, calls.find(c => c.action === 'control_begin').owner);
});

test('lost frame acknowledgement is not retried and releases ownership', async () => {
  const { controller, calls, frame } = fixture(true);
  assert.equal((await controller.request(target)).ok, true); await frame;
  for (let i = 0; controller.active && i < 100; i++) await new Promise(r => setTimeout(r, 5));
  assert.equal(controller.active, null);
  // Ownership is uncertain after a lost acknowledgement: the walk is cancelled, not blocked terrain.
  assert.equal(controller.view().state, 'cancelled');
  assert.match(controller.view().reason, /^control_lost/);
  assert.equal(calls.filter(c => c.action === 'control_step').length, 1);
  assert.equal(calls.filter(c => c.action === 'sense').length, 1);
  assert.equal(calls.filter(c => c.action === 'control_end').length, 1);
});

test('cancelling an in-flight startup cannot acquire control afterward', async () => {
  let entered;
  const waiting = new Promise(resolve => { entered = resolve; });
  const controller = new Controller((request, { signal }) => new Promise((resolve, reject) => {
    assert.equal(request.action, 'sense'); entered(); signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
  }));
  const starting = controller.request(target);
  await waiting; await controller.close();
  assert.equal((await starting).ok, false);
  assert.equal(controller.active, null);
});
