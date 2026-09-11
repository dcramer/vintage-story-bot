import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller/runtime.mjs';
import { Navigation } from '../src/navigation/navigator.mjs';
import { TerrainMemory } from '../src/navigation/terrain.mjs';
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
  assert.equal(direct[0].x, 1.5, 'safe planning anchor is not a physical waypoint');
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
  assert.equal(nav.lastReplan, 'stalled');
});

test('navigation counts camera convergence as bounded progress', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.progressAt = 0; nav.lastProgress = state.position;
  assert.equal(nav.tick(state, 2000).forward, false);
  assert.equal(nav.tick({ ...state, orientation: { yawDegrees: 30 } }, 4000).forward, false);
  assert.equal(nav.replans, 0);
  assert.equal(nav.progressAt, 4000);
});

test('navigation accepts a bounded waypoint crossing between slow samples', () => {
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

test('navigation sneaks through a nearby sharp waypoint', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: (_, to) => to.z === .5,
    views: () => new Map() };
  const state = { position: { x: .5, y: 0, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: 4.5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }, { x: 1.5, y: 0, z: 1.5 }];
  const frame = nav.tick(state, 500);
  assert.equal(frame.forward, true);
  assert.equal(frame.sneak, true);
});

test('navigation releases sneak for a validated descent', () => {
  const map = { cells: new Map(), support: () => 9, clear: () => true, traverse: () => true,
    views: () => new Map() };
  const state = { position: { x: .5, y: 1, z: .5 }, body: { halfWidth: .3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals: { hunger: { current: 1000, max: 1500 } } };
  const nav = new Navigation(map, state, { x: 5.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  nav.state = 'moving'; nav.route = [{ x: 1.5, y: 0, z: .5 }]; nav.edgeStart = state.position;
  const frame = nav.tick(state, 500);
  assert.equal(frame.forward, true);
  assert.equal(frame.sneak, true);
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
  assert.equal(controller.view().state, 'blocked');
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
