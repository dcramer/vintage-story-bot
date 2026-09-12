import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/runtime/controller.ts';
import { Navigation } from '../src/runtime/navigation/navigator.ts';
import { findRoute } from '../src/runtime/navigation/planner.ts';
import { horizontal, TerrainMemory } from '../src/runtime/navigation/terrain.ts';

function terrain() {
  const cells = [];
  for (let x = -3; x <= 4; x++)
    for (let z = -3; z <= 3; z++) for (let y = -2; y <= 4; y++) cells.push([x, y, z, 0, false, y < 0 ? [[0, 0, 0, 1, 1, 1]] : []]);
  return { session: 'terrain', reset: false, cursor: 1, more: false, clock: 0, cells };
}
const target = { action: 'move_to', x: 2.5, y: 0, z: 0.5, dimension: 0 };
function fixture(failFrame = false) {
  const calls = [],
    state = {
      ok: true,
      capabilities: [],
      player: { uid: 'bot' },
      position: { x: 0.5, y: 0, z: 0.5, dimension: 0 },
      controlReady: true,
      alive: true,
      motion: { onGround: true },
      life: { session: 'life', alerts: [], lastDamageAt: null },
      control: { epoch: 1, owner: null },
      body: { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
      orientation: { yawDegrees: 90, pitchDegrees: 20 },
    };
  let resolveFrame;
  const frame = new Promise(resolve => {
    resolveFrame = resolve;
  });
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
type Rule = (x: number, y: number, z: number) => boolean;
function world(width = 6, solid: Rule = () => false, hazard: Rule = () => false, unknown: Rule = () => false) {
  const map = new TerrainMemory(),
    cells = [];
  for (let x = -width; x <= width; x++)
    for (let z = -width; z <= width; z++)
      for (let y = -6; y <= 4; y++) {
        if (unknown(x, y, z)) continue;
        const floor = y === -1 || solid(x, y, z);
        cells.push([x, y, z, 0, hazard(x, y, z), floor ? [[0, 0, 0, 1, 1, 1]] : []]);
      }
  map.apply({ session: 'world', reset: true, cursor: 1, more: false, clock: 0, cells });
  return map;
}
const at = (x, z, y = 0) => ({ x: x + 0.5, y, z: z + 0.5 });

test('grid: a one-block step down beside water is a move; a deeper drop there is not', () => {
  const water = (x, y, z) => x === 1 && z === 1 && y === -1;
  const ledge = world(3, (x, y, z) => x === 0 && z === 0 && y === 0, water);
  const down = ledge.moves(at(0, 0, 1)).find(m => Math.floor(m.node.z) === 1 && Math.floor(m.node.x) === 0);
  assert.equal(down?.node.move, 'drop');
  const cliff = world(3, (x, y, z) => x === 0 && z === 0 && (y === 0 || y === 1), water);
  assert.equal(
    cliff.moves(at(0, 0, 2)).some(m => Math.floor(m.node.z) === 1 && Math.floor(m.node.x) === 0),
    false,
  );
});

test('grid: a cell stands when it has a floor, headroom and is known', () => {
  const map = world(
    3,
    (x, y, z) => x === 1 && z === 0 && y === 1,
    (x, y, z) => x === 2 && z === 0 && y === -1,
    (x, y, z) => x === -2 && z === 0 && y === 1,
  );
  assert.deepEqual(map.standable(0, -1, 0), at(0, 0));
  assert.equal(map.standable(1, -1, 0), null, 'a block at head height leaves no room');
  assert.equal(map.standable(2, -1, 0), null, 'water is not a floor');
  assert.equal(map.standable(-2, -1, 0), null, 'an unknown cell above is a wall');
  assert.equal(map.standable(0, 0, 0), null, 'air has no floor');
  assert.equal(map.standingOn({ x: 0.5, y: 0, z: 0.5 }), true);
  assert.equal(map.standingOn({ x: 0.5, y: 1.5, z: 0.5 }), false);
});

test('grid: moves step, jump one, drop three, never cut a corner or drop beside water', () => {
  const map = world(
    6,
    (x, y, z) => (x === 1 && z === 0 && y === 0) || (x === 2 && z === 0 && y >= 0 && y <= 1) || (x === 0 && z === 1 && y >= 0 && y <= 2),
    (x, y, z) => x === -3 && z === 2 && y === -1,
    (x, y, z) => x === -3 && z === -3 && y === 0,
  );
  // Deep side: west and south-west drop three blocks, south drops four.
  for (const [x, z] of [
    [-1, 0],
    [-1, -1],
    [0, -1],
  ])
    map.apply({
      session: 'world',
      reset: false,
      cursor: 2,
      more: false,
      clock: 0,
      cells: [
        [x, -1, z, 0, false, []],
        [x, -2, z, 0, false, []],
        [x, -3, z, 0, false, []],
        [x, -4, z, 0, false, [[0, 0, 0, 1, 1, 1]]],
      ],
    });
  map.apply({
    session: 'world',
    reset: false,
    cursor: 3,
    more: false,
    clock: 0,
    cells: [
      [0, -4, -1, 0, false, []],
      [0, -5, -1, 0, false, [[0, 0, 0, 1, 1, 1]]],
    ],
  });
  const moves = map.moves(at(0, 0));
  const to = (x, z) => moves.find(m => Math.floor(m.node.x) === x && Math.floor(m.node.z) === z);
  assert.equal(to(1, 0)?.node.move, 'jump', 'one block up is a jump');
  assert.equal(to(2, 0), undefined, 'two blocks up is out of reach');
  assert.equal(to(-1, 0)?.node.move, 'drop', 'three blocks down is a drop');
  assert.equal(to(0, -1), undefined, 'four blocks down is never planned');
  assert.equal(to(1, 1), undefined, 'diagonal blocked when both corner columns are solid');
  assert.equal(to(-1, -1), undefined, 'no diagonal drops');
  assert.equal(to(1, -1)?.node.move, 'walk', 'diagonal allowed when one corner side is open');
  assert.equal(
    world(3)
      .moves(at(0, 0))
      .filter(m => m.node.move === 'walk').length,
    8,
    'open ground walks in all eight directions',
  );
  assert.equal(to(0, 1), undefined, 'the tall wall column is not standable');
  const shore = map.moves(at(-2, 2)).find(m => Math.floor(m.node.x) === -3 && Math.floor(m.node.z) === 1);
  assert.ok(shore && shore.cost > 2, 'walking beside water costs more');
  assert.equal(
    map.moves(at(-2, 2)).find(m => Math.floor(m.node.x) === -3 && Math.floor(m.node.z) === 2),
    undefined,
    'water is a wall',
  );
});

test('grid: jumps diagonally out of a one-block pocket when a corner side is open', () => {
  // A pit at (0,0): walls one block high on the west and south, the northeast
  // is a block one up with the north cell open, so the way out is a diagonal jump.
  const map = world(
    3,
    (x, y, z) =>
      (x === -1 && z === 0 && y === 0) || (x === 0 && z === -1 && y === 0) || (x === 1 && z === 1 && y === 0) || (x === 1 && z === 0 && y === 0),
  );
  const out = map.moves(at(0, 0)).find(m => Math.floor(m.node.x) === 1 && Math.floor(m.node.z) === 1);
  assert.equal(out?.node.move, 'jump', 'the diagonal block one up is a jump out');
  assert.equal(Math.round(out.node.y), 1);
});

test('planner routes around a wall, jumps a hole only as a last resort, and ends partial routes at the frontier', () => {
  const wall = world(6, (x, y, z) => z === 1 && x <= 3 && y >= 0 && y <= 1);
  const route = findRoute(wall, at(0, 0), at(0, 4), 0.3, 1.85, { partial: false });
  assert.ok(
    route?.some(n => Math.floor(n.x) >= 4),
    'goes around the wall end',
  );
  assert.ok(route.every(n => n.move !== 'jump' && n.move !== 'gap'));
  const hole = world(
    6,
    () => false,
    () => false,
    () => false,
  );
  hole.apply({
    session: 'world',
    reset: false,
    cursor: 2,
    more: false,
    clock: 0,
    cells: [-6, -5, -4, -3, -2, -1, 0, 1, 2, 3, 4, 5, 6].flatMap(z => [
      [1, -1, z, 0, false, []],
      [1, -2, z, 0, false, []],
      [1, -3, z, 0, false, []],
      [1, -4, z, 0, false, []],
      [1, -5, z, 0, false, []],
      [1, -6, z, 0, false, []],
    ]),
  });
  const over = findRoute(hole, at(0, 0), at(3, 0), 0.3, 1.85, { partial: false });
  assert.equal(over?.[0].move, 'gap', 'a full-width trench is crossed by a gap jump');
  const partial = findRoute(world(3), at(0, 0), at(20, 0), 0.3, 1.85);
  assert.ok(partial?.length, 'a goal beyond what was seen yields a partial route');
  assert.ok(Math.floor(partial.at(-1).x) >= 2, 'the partial route heads toward the goal');
  const deadline = findRoute(world(6), at(-5, -5), at(5, 5), 0.3, 1.85, { deadlineMs: 0 });
  assert.ok(deadline === null || Array.isArray(deadline), 'a spent deadline still returns cleanly');
});

test('a partial route never ends down a drop the body cannot climb back, unless the goal itself lies low', () => {
  // A plateau two blocks high on the west, a valley floor east of it, nothing known beyond x = 6.
  const plateau = world(
    8,
    (x, y, z) => x <= 2 && (y === 0 || y === 1),
    () => false,
    (x, _y, _z) => x > 6,
  );
  const along = findRoute(plateau, at(0, 0, 2), { x: 30.5, y: 2, z: 0.5, horizontalOnly: true }, 0.3, 1.85);
  assert.ok(!along || along.at(-1).y >= 2, 'a goal at plateau height: the frontier down in the valley is no frontier');
  const down = findRoute(plateau, at(0, 0, 2), { x: 30.5, y: 0, z: 0.5 }, 0.3, 1.85);
  assert.ok(down?.length && down.at(-1).y === 0 && Math.floor(down.at(-1).x) >= 3, 'a goal down in the valley: the descent is the way');
});

test('a run over gentle ground merges; a block up does not', () => {
  const flat = world(6);
  assert.equal(flat.runWalkable(at(0, 0), at(5, 0)), true);
  const stepUp = world(6, (x, y, _z) => x >= 3 && y === 0);
  assert.equal(stepUp.runWalkable(at(0, 0), at(5, 0, 1)), false, 'a full block needs a jump, not a stride');
});

test('navigation plans ahead while walking: a route extended by the far view is taken in stride', () => {
  const map = world(
    3,
    () => false,
    () => false,
    (x, _y, _z) => x > 3,
  );
  const body = { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
    vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(-2, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 20.5, y: 0, z: 0.5, horizontalOnly: true, timeoutMs: 20000 }, 0);
  nav.tick(state, 0);
  assert.equal(nav.state, 'moving');
  assert.equal(nav.routeReaches, false, 'the goal is beyond what was seen: a partial route');
  const before = Math.floor(nav.route.at(-1).x);
  const cells = [];
  for (let x = 4; x <= 12; x++)
    for (let z = -3; z <= 3; z++) for (let y = -6; y <= 4; y++) cells.push([x, y, z, 0, false, y === -1 ? [[0, 0, 0, 1, 1, 1]] : []]);
  map.apply({ session: 'world', reset: false, cursor: 2, more: false, clock: 0, cells });
  const walking = { ...state, position: { x: 0.5, y: 0, z: 0.5 } };
  const frame = nav.tick(walking, 1000);
  assert.equal(nav.state, 'moving', 'no survey stop at the old frontier');
  assert.ok(Math.floor(nav.route.at(-1).x) > before, 'the route now runs on over the ground that came into view');
  assert.ok(frame?.toward, 'and the body keeps walking');
});

test('navigation hands the mod one point per step, hops for a block up, and takes its arrival', () => {
  const map = world(6, (x, y, z) => x === 3 && z === 0 && y === 0);
  const body = { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
    vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(0, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 0 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 3.5, y: 1, z: 0.5, timeoutMs: 10000 }, 0);
  const first = nav.tick(state, 0);
  assert.equal(nav.state, 'moving');
  assert.equal(first.sneak, false);
  assert.ok(first.toward, 'a step is a point the mod walks to with its hand on the keys every tick');
  assert.equal(first.hop, false);
  assert.equal(first.durationMs, 500);
  const facing = { ...state, position: at(2, 0), orientation: { yawDegrees: 90 } };
  const jump = nav.tick(facing, 500);
  assert.equal(nav.route[nav.index].move, 'jump');
  assert.equal(jump.hop, true, 'the block up is a hop the mod times itself');
  assert.equal(jump.jump, false);
  const airborne = { ...facing, position: { x: 2.9, y: 0.6, z: 0.5 }, motion: { onGround: false } };
  assert.equal(nav.tick(airborne, 600).hop, true, 'still the same hop while in the air');
  const landed = { ...facing, position: at(3, 0, 1), orientation: { yawDegrees: 90 } };
  nav.tick(landed, 800);
  assert.equal(nav.state, 'arrived');
});

test('navigation replans without stopping when the next cell stops being standable', () => {
  const map = world(6);
  const body = { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
    vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(0, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: 0.5, timeoutMs: 10000 }, 0);
  assert.ok(nav.tick(state, 0).forward);
  const next = nav.route[nav.index];
  map.apply({
    session: 'world',
    reset: false,
    cursor: 2,
    more: false,
    clock: 0,
    cells: [
      [Math.floor(next.x), 0, Math.floor(next.z), 0, false, [[0, 0, 0, 1, 1, 1]]],
      [Math.floor(next.x), 1, Math.floor(next.z), 0, false, [[0, 0, 0, 1, 1, 1]]],
    ],
  });
  const frame = nav.tick(state, 500);
  assert.equal(nav.lastReplan, 'terrain_changed');
  assert.equal(nav.state, 'moving');
  assert.ok(frame, 'the same tick produces a frame from the new route');
  assert.equal(nav.replans, 1);
});

test('navigation steps off a drop and replans at once when the mod reports the step blocked', () => {
  const map = world(6);
  map.apply({
    session: 'world',
    reset: false,
    cursor: 2,
    more: false,
    clock: 0,
    cells: [
      [1, -1, 0, 0, false, []],
      [1, -2, 0, 0, false, []],
      [1, -3, 0, 0, false, [[0, 0, 0, 1, 1, 1]]],
      [2, -1, 0, 0, false, []],
      [2, -2, 0, 0, false, []],
      [2, -3, 0, 0, false, [[0, 0, 0, 1, 1, 1]]],
    ],
  });
  const body = { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
    vitals = { hunger: { current: 1000, max: 1500 } };
  const state = { position: at(0, 0), body, motion: { onGround: true }, orientation: { yawDegrees: 90 }, vitals, nearbyEntities: [] };
  const nav = new Navigation(map, state, { x: 2.5, y: -2, z: 0.5, timeoutMs: 10000 }, 0);
  const first = nav.tick(state, 0);
  assert.equal(nav.route[0].move, 'drop');
  assert.equal(first.forward, true);
  assert.ok(first.toward && !first.hop, 'a drop is a plain step; the mod lets go of forward in the air');
  const falling = { ...state, position: { x: 1.3, y: -0.8, z: 0.5 }, motion: { onGround: false } };
  assert.ok(nav.tick(falling, 300).toward, 'the same step continues while falling');
  const stuck = { ...falling, motion: { onGround: true } };
  nav.tick(stuck, 800, { state: 'blocked', toward: first.toward, distance: 0.9 });
  assert.equal(nav.lastReplan, 'stalled', 'blocked on the point means a replan now');
});

test('navigation temporarily routes away from an explicit nearby hostile', () => {
  const map = new TerrainMemory();
  map.apply(terrain());
  const state = {
    position: { x: 0.5, y: 0, z: 0.5 },
    body: { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true },
    orientation: { yawDegrees: 90 },
    vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [{ key: 'entity:1', code: 'game:wolf-male', point: { x: -0.5, y: 0, z: 0.5 } }],
  };
  const goal = { x: 5.5, y: 0, z: 0.5, timeoutMs: 10000 };
  const distant = { ...state, nearbyEntities: [{ ...state.nearbyEntities[0], point: { x: -28.5, y: 0, z: 0.5 } }] };
  const calm = new Navigation(map, distant, goal, 0);
  calm.tick(distant, 0);
  assert.equal(calm.evading, false);
  const nav = new Navigation(map, state, goal, 0);
  assert.ok(nav.tick(state, 0));
  assert.equal(nav.evading, true);
  assert.ok(nav.target.x > goal.x && nav.target.emergency);
  nav.tick(distant, 1);
  assert.equal(nav.evading, true);
  nav.tick({ ...state, nearbyEntities: [{ ...state.nearbyEntities[0], point: { x: -36.5, y: 0, z: 0.5 } }] }, 2);
  assert.equal(nav.evading, false);
  assert.equal(nav.target, goal);
});

test('evasion route does not approach another visible hostile', () => {
  const map = new TerrainMemory();
  map.apply(terrain());
  const start = { x: 0.5, y: 0, z: 0.5 };
  const west = { key: 'entity:1', code: 'game:wolf-male', point: { x: -1.5, y: 0, z: 0.5 } };
  const east = { key: 'entity:2', code: 'game:bowtorn-surface', point: { x: 2.5, y: 0, z: 0.5 } };
  const state = {
    position: start,
    body: { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
    motion: { onGround: true },
    orientation: { yawDegrees: 0 },
    vitals: { hunger: { current: 1000, max: 1500 } },
    nearbyEntities: [west, east],
  };
  const nav = new Navigation(map, state, { x: 4.5, y: 0, z: 0.5, timeoutMs: 10000 }, 0);
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
  assert.equal(result.ok, true);
  await frame;
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
  assert.equal((await controller.request(target)).ok, true);
  await frame;
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
  const waiting = new Promise(resolve => {
    entered = resolve;
  });
  const controller = new Controller(
    (request, { signal }) =>
      new Promise((_resolve, reject) => {
        assert.equal(request.action, 'sense');
        entered();
        signal.addEventListener('abort', () => reject(Error('cancelled')), { once: true });
      }),
  );
  const starting = controller.request(target);
  await waiting;
  await controller.close();
  assert.equal((await starting).ok, false);
  assert.equal(controller.active, null);
});

test('knowledge survives a round trip through disk and is keyed by world', async () => {
  const { mkdtempSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const { Knowledge } = await import('../src/runtime/navigation/knowledge.ts');
  const { SurfaceMemory } = await import('../src/runtime/navigation/surface.ts');
  const { SightingsMemory } = await import('../src/runtime/navigation/sightings.ts');
  const dir = mkdtempSync(join(tmpdir(), 'seraph-knowledge-'));
  const memories = { map: new TerrainMemory(), surface: new SurfaceMemory(), sightings: new SightingsMemory() };
  const knowledge = new Knowledge(dir, memories);
  knowledge.enter('world-a');
  memories.map.apply(terrain(), 1000);
  memories.surface.apply({ clock: 5, sweeps: 1, columns: [[1, 2, 10, 'ground', 1, 'soil', 5]] }, 1000);
  memories.sightings.apply(
    {
      clock: 5,
      sightings: [
        ['block:1', 'block', 'game:bush', 1.5, 10.5, 2.5, 'seen', 5, { facts: { growth: 'ripe' } }],
        ['entity:9', 'entity', 'game:wolf', 3, 10, 3, 'seen', 5, null],
      ],
    },
    1000,
  );
  knowledge.touch();
  assert.equal(knowledge.save(true), true);
  const fresh = { map: new TerrainMemory(), surface: new SurfaceMemory(), sightings: new SightingsMemory() };
  const again = new Knowledge(dir, fresh);
  again.enter('world-a');
  assert.equal(fresh.map.cells.size, memories.map.cells.size, 'terrain cells restored');
  assert.deepEqual(fresh.map.standable(0, -1, 0), { x: 0.5, y: 0, z: 0.5 }, 'restored geometry is usable');
  assert.equal(fresh.surface.get(1, 2)?.kind, 'ground');
  assert.equal(fresh.sightings.remembered('block').length, 1, 'blocks persist');
  assert.equal(fresh.sightings.remembered('entity').length, 0, 'entities do not');
  again.enter('world-b');
  assert.equal(fresh.map.cells.size, 0, 'another world starts empty');
});
