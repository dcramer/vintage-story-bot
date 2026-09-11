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


// A small block world: floor at y=-1 everywhere unless overridden, air above.
function world(width = 6, solid = () => false, hazard = () => false, unknown = () => false) {
  const map = new TerrainMemory(), cells = [];
  for (let x = -width; x <= width; x++) for (let z = -width; z <= width; z++) for (let y = -6; y <= 4; y++) {
    if (unknown(x, y, z)) continue;
    const floor = y === -1 || solid(x, y, z);
    cells.push([x, y, z, 0, hazard(x, y, z), floor ? [[0, 0, 0, 1, 1, 1]] : []]);
  }
  map.apply({ session: 'world', reset: true, cursor: 1, more: false, clock: 0, cells });
  return map;
}
const at = (x, z, y = 0) => ({ x: x + .5, y, z: z + .5 });

test('grid: a cell stands when it has a floor, headroom and is known', () => {
  const map = world(3, (x, y, z) => x === 1 && z === 0 && y === 1, (x, y, z) => x === 2 && z === 0 && y === -1,
    (x, y, z) => x === -2 && z === 0 && y === 1);
  assert.deepEqual(map.standable(0, -1, 0), at(0, 0));
  assert.equal(map.standable(1, -1, 0), null, 'a block at head height leaves no room');
  assert.equal(map.standable(2, -1, 0), null, 'water is not a floor');
  assert.equal(map.standable(-2, -1, 0), null, 'an unknown cell above is a wall');
  assert.equal(map.standable(0, 0, 0), null, 'air has no floor');
  assert.equal(map.standingOn({ x: .5, y: 0, z: .5 }), true);
  assert.equal(map.standingOn({ x: .5, y: 1.5, z: .5 }), false);
});

test('grid: moves step, jump one, drop three, never cut a corner or drop beside water', () => {
  const map = world(6,
    (x, y, z) => x === 1 && z === 0 && y === 0 || x === 2 && z === 0 && y >= 0 && y <= 1 || x === 0 && z === 1 && y >= 0 && y <= 2,
    (x, y, z) => x === -3 && z === 2 && y === -1,
    (x, y, z) => x === -3 && z === -3 && y === 0);
  // Deep side: west and south-west drop three blocks, south drops four.
  for (const [x, z] of [[-1, 0], [-1, -1], [0, -1]]) map.apply({ session: 'world', reset: false, cursor: 2, more: false, clock: 0,
    cells: [[x, -1, z, 0, false, []], [x, -2, z, 0, false, []], [x, -3, z, 0, false, []], [x, -4, z, 0, false, [[0, 0, 0, 1, 1, 1]]]] });
  map.apply({ session: 'world', reset: false, cursor: 3, more: false, clock: 0,
    cells: [[0, -4, -1, 0, false, []], [0, -5, -1, 0, false, [[0, 0, 0, 1, 1, 1]]]] });
  const moves = map.moves(at(0, 0));
  const to = (x, z) => moves.find(m => Math.floor(m.node.x) === x && Math.floor(m.node.z) === z);
  assert.equal(to(1, 0)?.node.move, 'jump', 'one block up is a jump');
  assert.equal(to(2, 0), undefined, 'two blocks up is out of reach');
  assert.equal(to(-1, 0)?.node.move, 'drop', 'three blocks down is a drop');
  assert.equal(to(0, -1), undefined, 'four blocks down is never planned');
  assert.equal(to(1, 1), undefined, 'no diagonal jumps');
  assert.equal(to(-1, -1), undefined, 'no diagonal drops');
  assert.equal(to(1, -1), undefined, 'no corner cut past the raised block beside the path');
  assert.equal(world(3).moves(at(0, 0)).filter(m => m.node.move === 'walk').length, 8, 'open ground walks in all eight directions');
  // A wall column at (0,1) blocks the diagonal past it, not the cardinal beside it.
  assert.equal(to(0, 1), undefined);
  assert.equal(to(-1, 1) && to(0, 1), undefined);
  const corner = map.moves(at(1, 1)).find(m => Math.floor(m.node.x) === 0 && Math.floor(m.node.z) === 2);
  assert.equal(corner, undefined, 'diagonal past the wall column is a corner cut');
  const shore = map.moves(at(-2, 2)).find(m => Math.floor(m.node.x) === -3 && Math.floor(m.node.z) === 1);
  assert.ok(shore && shore.cost > 2, 'walking beside water costs more');
  assert.equal(map.moves(at(-2, 2)).find(m => Math.floor(m.node.x) === -3 && Math.floor(m.node.z) === 2), undefined, 'water is a wall');
});

test('planner routes around a wall, jumps a hole only as a last resort, and ends partial routes at the frontier', () => {
  const wall = world(6, (x, y, z) => z === 1 && x <= 3 && y >= 0 && y <= 1);
  const route = findRoute(wall, at(0, 0), at(0, 4), .3, 1.85, { partial: false });
  assert.ok(route && route.some(n => Math.floor(n.x) >= 4), 'goes around the wall end');
  assert.ok(route.every(n => n.move !== 'jump' && n.move !== 'gap'));
  const hole = world(6, () => false, () => false, () => false);
  hole.apply({ session: 'world', reset: false, cursor: 2, more: false, clock: 0,
    cells: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].flatMap(z => [[1, -1, z, 0, false, []], [1, -2, z, 0, false, []], [1, -3, z, 0, false, []], [1, -4, z, 0, false, []], [1, -5, z, 0, false, []], [1, -6, z, 0, false, []]]) });
  const over = findRoute(hole, at(0, 0), at(3, 0), .3, 1.85, { partial: false });
  assert.equal(over?.[0].move, 'gap', 'a full-width trench is crossed by a gap jump');
  const partial = findRoute(world(3), at(0, 0), at(20, 0), .3, 1.85);
  assert.ok(partial && partial.length, 'a goal beyond what was seen yields a partial route');
  assert.ok(Math.floor(partial.at(-1).x) >= 2, 'the partial route heads toward the goal');
  const deadline = findRoute(world(6), at(-5, -5), at(5, 5), .3, 1.85, { deadlineMs: 0 });
  assert.ok(deadline === null || Array.isArray(deadline), 'a spent deadline still returns cleanly');
});

test('navigation walks through bends without crouching, jumps a block up from close by', () => {
  const map = world(6, (x, y, z) => x === 3 && z === 0 && y === 0);
  const body = { halfWidth: .3, height: 1.85, eyeHeight: 1.7 }, vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(0, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 3.5, y: 1, z: .5, timeoutMs: 10000 }, 0);
  const first = nav.tick(state, 0);
  assert.equal(nav.state, 'moving');
  assert.equal(first.sneak, false);
  assert.equal(first.forward, true, 'walks while turning 90 degrees in a short frame');
  assert.equal(first.durationMs, 180);
  const facing = { ...state, position: at(2, 0), orientation: { yawDegrees: 90 } };
  const jump = nav.tick(facing, 500);
  assert.equal(nav.route[nav.index].move, 'jump');
  assert.equal(jump.jump, true, 'jumps when the block up is close and lined up');
  const airborne = { ...facing, position: { x: 2.9, y: .6, z: .5 }, motion: { onGround: false } };
  assert.equal(nav.tick(airborne, 600).forward, true, 'keeps forward through the jump');
  const landed = { ...facing, position: at(3, 0, 1), orientation: { yawDegrees: 90 } };
  nav.tick(landed, 800);
  assert.equal(nav.state, 'arrived');
});

test('navigation replans without stopping when the next cell stops being standable', () => {
  const map = world(6);
  const body = { halfWidth: .3, height: 1.85, eyeHeight: 1.7 }, vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(0, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: .5, timeoutMs: 10000 }, 0);
  assert.ok(nav.tick(state, 0).forward);
  const next = nav.route[nav.index];
  map.apply({ session: 'world', reset: false, cursor: 2, more: false, clock: 0,
    cells: [[Math.floor(next.x), 0, Math.floor(next.z), 0, false, [[0, 0, 0, 1, 1, 1]]], [Math.floor(next.x), 1, Math.floor(next.z), 0, false, [[0, 0, 0, 1, 1, 1]]]] });
  const frame = nav.tick(state, 500);
  assert.equal(nav.lastReplan, 'terrain_changed');
  assert.equal(nav.state, 'moving');
  assert.ok(frame, 'the same tick produces a frame from the new route');
  assert.equal(nav.replans, 1);
});

test('navigation lets gravity finish a drop and stalls into a replan', () => {
  const map = world(6);
  map.apply({ session: 'world', reset: false, cursor: 2, more: false, clock: 0,
    cells: [[1, -1, 0, 0, false, []], [1, -2, 0, 0, false, []], [1, -3, 0, 0, false, [[0, 0, 0, 1, 1, 1]]],
      [2, -1, 0, 0, false, []], [2, -2, 0, 0, false, []], [2, -3, 0, 0, false, [[0, 0, 0, 1, 1, 1]]]] });
  const body = { halfWidth: .3, height: 1.85, eyeHeight: 1.7 }, vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(0, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 2.5, y: -2, z: .5, timeoutMs: 10000 }, 0);
  const first = nav.tick(state, 0);
  assert.equal(nav.route[0].move, 'drop');
  assert.equal(first.forward, true);
  const falling = { ...state, position: { x: 1.3, y: -.8, z: .5 }, motion: { onGround: false } };
  assert.equal(nav.tick(falling, 300).forward, false, 'forward released while airborne');
  const stuck = { ...falling, motion: { onGround: true } };
  nav.tick(stuck, 3500);
  assert.equal(nav.lastReplan, 'stalled');
});

test('navigation temporarily routes away from an explicit nearby hostile', () => {
  const map = new TerrainMemory(); map.apply(terrain());
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
