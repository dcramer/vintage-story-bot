import assert from 'node:assert/strict';
import { test } from 'node:test';
import { failEdge, failedEdges } from '../src/runtime/navigation/failed-edges.ts';
import { visitedFrontiers, visitFrontier } from '../src/runtime/navigation/frontiers.ts';
import { Navigation, NO_PROGRESS_MS } from '../src/runtime/navigation/navigator.ts';
import { clearanceRemaining, findRoute } from '../src/runtime/navigation/planner.ts';
import { distance, horizontal, TerrainMemory } from '../src/runtime/navigation/terrain.ts';

const stateAt = position => ({
  position,
  body: { halfWidth: 0.3, height: 1.85, eyeHeight: 1.7 },
  motion: { onGround: true },
  orientation: { yawDegrees: 114 },
  nearbyEntities: [],
});
function column(map, x, z, floor = true) {
  for (let y = -1; y < 4; y++) map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: y === -1 && floor ? [[x, y, z, x + 1, y + 1, z + 1]] : [] });
}

test('grounded player can leave a cell whose floor is hidden by a loose object', () => {
  const map = new TerrainMemory();
  column(map, 0, 0, false);
  column(map, 1, 0);
  const state = stateAt({ x: 0.5, y: 0, z: 0.5 });
  assert.equal(map.standingOn(state.position), false);
  const nav = new Navigation(map, state, { x: 1.5, y: 0, z: 0.5 }, 0);
  const frame = nav.tick(state, 0);
  assert.equal(nav.state, 'moving');
  assert.deepEqual(frame.toward, { x: 1.5, y: 0, z: 0.5 });
});

test('escape follows a safe detour that initially approaches a distant hostile', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 3; x++) column(map, x, 0);
  for (let z = 0; z <= 5; z++) column(map, 3, z);
  for (let x = -8; x <= 3; x++) column(map, x, 5);
  const state = {
    ...stateAt({ x: 0.5, y: 0, z: 0.5 }),
    nearbyEntities: [{ key: 'drifter', code: 'game:drifter-normal', point: { x: 10.5, y: 0, z: 0.5 }, ageMs: 0 }],
  };
  const nav = new Navigation(map, state, { x: -8.5, y: 0, z: 5.5 }, 0);
  const frame = nav.tick(state, 0);
  assert.equal(nav.evading, true);
  assert.notEqual(nav.lastReplan, 'route_toward_threat');
  assert.ok(frame?.toward, 'the planned detour must send a movement step');
  assert.ok(nav.nextCheckpoint.x > state.position.x);
  assert.ok(horizontal(nav.nextCheckpoint, state.nearbyEntities[0].point) > 3);
});

test('swimming routes hold jump through shallow contacts only with mod support', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 4; x++) {
    column(map, x, 0);
    for (let y = 0; y <= 1; y++) map.put({ x, y, z: 0, seenAt: Date.now(), traits: ['water'], boxes: [] });
  }
  for (const supported of [false, true]) {
    const state = {
      ...stateAt({ x: 0.5, y: 0.5, z: 0.5 }),
      capabilities: supported ? ['step_jump_hold'] : [],
      motion: { onGround: true, feetInLiquid: true },
    };
    const nav = new Navigation(map, state, { x: 3.5, y: 0.5, z: 0.5 }, 0);
    assert.equal(nav.tick(state, 0).jump, supported);
  }
});

test('resuming after a bear escape routes around its remembered position instead of reentering it', () => {
  const map = new TerrainMemory();
  for (let x = -40; x <= 45; x++) for (let z = -27; z <= 27; z++) column(map, x, z);
  const bear = { key: 'bear', code: 'game:bear-black-adult-female', point: { x: 0.5, y: 0, z: 0.5 }, ageMs: 0 };
  const state = { ...stateAt({ x: -19.5, y: 0, z: 0.5 }), nearbyEntities: [bear] };
  const target = { x: 40.5, y: 0, z: 0.5, timeoutMs: 120000 };
  const nav = new Navigation(map, state, target, 0);
  nav.tick(state, 0);
  assert.equal(nav.evading, true);
  state.position = { x: -30.5, y: 0, z: 0.5 };
  state.nearbyEntities = [];
  nav.tick(state, 1000);
  assert.equal(nav.evading, false);
  const route = findRoute(map, state.position, target, 0, 0, { avoid: nav.avoid, partial: false, budget: 8192 });
  assert.ok(route, 'the original destination remains reachable around the bear');
  assert.ok(
    route.every(p => horizontal(p, bear.point) >= 24),
    'clearing the threat cannot discard its position',
  );
  state.position = { x: -33.5, y: 0, z: 0.5 };
  nav.survey(61000);
  nav.tick(state, 61000);
  const expired = findRoute(map, state.position, target, 0, 0, { avoid: nav.avoid, partial: false, budget: 8192 });
  assert.ok(
    expired.some(p => horizontal(p, bear.point) < 3),
    'an old sighting cannot block the route forever',
  );
});

test('swimmers and waders can climb a clear bank without treating their water as a ceiling', () => {
  for (const deep of [false, true]) {
    const map = new TerrainMemory();
    column(map, 0, 0);
    column(map, 1, 0);
    for (let y = 0; y <= (deep ? 1 : 0); y++) map.put({ x: 0, y, z: 0, seenAt: Date.now(), traits: ['water'], boxes: [] });
    const top = deep ? 2 : 1;
    for (let y = 0; y < top; y++) map.put({ x: 1, y, z: 0, seenAt: Date.now(), traits: [], boxes: [[1, y, 0, 2, y + 1, 1]] });
    const start = map.nodeAt(0, 0, deep ? 0.5 : 0);
    assert.ok(
      map.moves(start).some(({ node }) => node.x === 1.5 && node.y === top),
      'surface-level bank must be reachable',
    );
    const state = { ...stateAt(start), capabilities: ['step_jump_hold'], motion: { onGround: !deep, feetInLiquid: true, swimming: deep } };
    const bank = { x: 1.5, y: top, z: 0.5, move: 'jump' };
    const nav = new Navigation(map, state, bank, 0);
    nav.adopt([bank], start, 0);
    const frame = nav.tick(state, 0);
    assert.equal(frame.hop, true);
    assert.equal(frame.jump, true, 'swim input continues while approaching a dry bank');
    assert.ok(frame.reachY < top - start.y, 'water tolerance must not suppress the bank jump');
    map.put({ x: 0, y: top, z: 0, seenAt: Date.now(), traits: [], boxes: [[0, top, 0, 1, top + 1, 1]] });
    assert.ok(!map.moves(start).some(({ node }) => node.x === 1.5), 'a solid ceiling must still prevent the climb');
  }
});

test('a shortcut refused by the cliff guard follows its original checkpoint and still times out when stationary', () => {
  const map = new TerrainMemory();
  for (let x = 0; x < 4; x++) for (let z = 0; z < 3; z++) column(map, x, z, x !== 1 || z !== 1);
  const state = stateAt({ x: 0.6222721894, y: 0, z: 1.3277178842 });
  const first = { x: 1.5, y: 0, z: 0.5, move: 'walk' };
  const end = { x: 2.5, y: 0, z: 0.5, move: 'walk' };
  const nav = new Navigation(map, state, end, 0);
  nav.adopt([first, end], state.position, 0);
  const frame = nav.tick(state, 0);
  assert.equal(frame.forward, true);
  assert.deepEqual(frame.toward, { x: first.x, y: first.y, z: first.z });
  for (let at = 100; at <= 4200 && !nav.replans; at += 100) nav.tick(state, at);
  assert.ok(nav.replans > 0, 'a stationary body must replan instead of renewing the same shortcut');
});

test('a two-block descent carries only with an observed level run beyond the landing', () => {
  for (const length of [1, 2]) {
    const map = new TerrainMemory();
    for (let x = 0; x <= length + 1; x++)
      for (let y = -3; y < 3; y++)
        map.put({ x, y, z: 0, seenAt: Date.now(), traits: [], boxes: y === (x === 0 ? -1 : -3) ? [[x, y, 0, x + 1, y + 1, 1]] : [] });
    const state = { ...stateAt({ x: 0.5, y: 0, z: 0.5 }), vitals: { hunger: { current: 1000, max: 1500 } } };
    const route = Array.from({ length: length + 1 }, (_, i) => ({ x: i + 1.5, y: -2, z: 0.5, move: i ? 'walk' : 'drop' }));
    const nav = new Navigation(map, state, { ...route.at(-1), sprint: true }, 0);
    nav.adopt(route, state.position, 0);
    const frame = nav.tick(state, 0);
    assert.equal(!!frame.next, length === 2);
    assert.equal(frame.sprint, length === 2);
    assert.equal(map.moves(state.position).find(({ node }) => node.x === 1.5).cost, length === 2 ? 1.8 : 4);
  }
});

test('a partial route extends in stride when new terrain replaces old cells at capacity', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 4; x++) column(map, x, 0);
  for (let x = 100; x <= 103; x++) column(map, x, 0);
  map.cells.capacity = map.cells.size;
  const size = map.cells.size;
  const state = stateAt({ x: 0.5, y: 0, z: 0.5 });
  const nav = new Navigation(map, state, { x: 8.5, y: 0, z: 0.5 }, 0);
  nav.tick(state, 0);
  assert.equal(nav.routeReaches, false);
  // Refresh the nearby ground, then fill in the forward view and evict the distant old columns.
  for (let x = 0; x <= 8; x++) column(map, x, 0);
  map.cells.bound(
    Date.now(),
    () => false,
    id => map.forget(id),
  );
  assert.equal(map.cells.size, size);
  state.position.x = 1.5;
  const frame = nav.tick(state, 1000);
  assert.equal(nav.routeReaches, true);
  assert.equal(nav.route.at(-1).x, 8.5);
  assert.equal(frame.forward, true);
});

test('a merged run keeps input reach margin and falls back when the body drifts away during a turn', () => {
  const map = new TerrainMemory();
  for (let x = -2; x <= 12; x++) for (let z = -1; z <= 1; z++) column(map, x, z);
  const state = stateAt({ x: 0.5, y: 0, z: 0.5 });
  const nav = new Navigation(map, state, { x: 10.5, y: 0, z: 0.5 }, 0);
  nav.adopt(
    Array.from({ length: 10 }, (_, i) => ({ x: i + 1.5, y: 0, z: 0.5, move: 'walk' })),
    state.position,
    0,
  );
  const first = nav.tick(state, 0);
  assert.ok(distance(state.position, first.toward) <= 7, 'leave room for movement before the mod processes the frame');
  state.position = { x: -0.5, y: 0, z: 0.5 };
  const turning = nav.tick(state, 100);
  assert.ok(distance(state.position, turning.toward) <= 7, 'a previously merged point cannot drift out of reach');
  assert.equal(turning.toward.x, 1.5, 'return to the original nearby checkpoint');
});

test('an uphill takeoff starts before the riser only with a clear earlier jump arc', () => {
  for (const [ceiling, sprinting] of [
    [false, false],
    [true, false],
    [false, true],
    [true, true],
  ]) {
    const map = new TerrainMemory();
    for (let x = -1; x <= 3; x++) column(map, x, 0);
    map.put({ x: 2, y: 0, z: 0, seenAt: Date.now(), traits: [], boxes: [[2, 0, 0, 3, 1, 1]] });
    if (ceiling) map.put({ x: 0, y: 2, z: 0, seenAt: Date.now(), traits: [], boxes: [[0, 2, 0, 1, 3, 1]] });
    const state = { ...stateAt({ x: sprinting ? -0.8 : 0.8, y: 0, z: 0.5 }), motion: { onGround: true, sprinting } };
    const landing = { x: 2.5, y: 1, z: 0.5, move: 'jump' };
    const nav = new Navigation(map, state, landing, 0);
    nav.adopt([{ x: 1.5, y: 0, z: 0.5, move: 'walk' }, landing], state.position, 0);
    const frame = nav.tick(state, 0);
    assert.equal(frame.toward.x, ceiling ? 1.5 : 2.5);
    assert.equal(frame.hop, !ceiling);
  }
});

test('replanning and revisiting checkpoints cannot renew movement progress indefinitely', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 30; x++) column(map, x, 0);
  const state = stateAt({ x: 0.5, y: 0, z: 0.5 });
  const end = { x: 30.5, y: 0, z: 0.5, move: 'walk' };
  const nav = new Navigation(map, state, end, 0);
  for (let at = 0; at <= NO_PROGRESS_MS + 2000 && nav.active; at += 1000) {
    state.position = { x: at % 2000 ? 2.5 : 0.5, y: 0, z: 0.5 };
    nav.adopt([{ ...state.position, move: 'walk' }, end], state.position, at);
    nav.tick(state, at);
  }
  assert.equal(nav.state, 'blocked');
  assert.equal(nav.reason, 'no_progress');
  const moving = new Navigation(map, state, end, 0);
  for (let at = 0; at <= NO_PROGRESS_MS + 2000; at += 1000) {
    state.position = { x: 0.5 + at / 1000, y: 0, z: 0.5 };
    moving.adopt([end], state.position, at);
    moving.tick(state, at);
  }
  assert.equal(moving.active, true, 'new ground remains progress even across replans');
});

test('swimming and wading queue the next checkpoint instead of stopping at every water cell', () => {
  for (const deep of [true, false]) {
    const map = new TerrainMemory();
    for (let x = 0; x <= 4; x++)
      for (let y = -2; y <= 3; y++)
        map.put({
          x,
          y,
          z: 0,
          seenAt: Date.now(),
          traits: y === 0 || (deep && y === -1) ? ['water'] : [],
          boxes: y === -2 || (!deep && y === -1) ? [[x, y, 0, x + 1, y + 1, 1]] : [],
        });
    const origin = map.nodeAt(0, 0, 0);
    const state = { ...stateAt(origin), motion: { onGround: !deep, feetInLiquid: true, swimming: deep } };
    const first = { ...map.nodeAt(1, 0, 0), move: deep ? 'swim' : 'wade' };
    const after = { ...map.nodeAt(2, 0, 0), move: first.move };
    const nav = new Navigation(map, state, after, 0);
    nav.adopt([first, after], origin, 0);
    nav.mergeRefused = true;
    const frame = nav.tick(state, 0);
    assert.deepEqual(frame.next, { x: after.x, y: after.y, z: after.z, hop: false });
    assert.equal(frame.forward, true);
    assert.equal(frame.sprint, false);
  }
});

test('open water permits diagonal swimming while solid bank corners remain blocked', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 2; x++)
    for (let z = 0; z <= 2; z++)
      for (let y = -2; y <= 3; y++)
        map.put({
          x,
          y,
          z,
          seenAt: Date.now(),
          traits: y === 0 || y === -1 ? ['water'] : [],
          boxes: y === -2 ? [[x, y, z, x + 1, y + 1, z + 1]] : [],
        });
  const origin = map.nodeAt(0, 0, 0);
  const diagonal = () => map.moves(origin).some(({ node }) => node.x === 1.5 && node.z === 1.5 && node.swim);
  assert.equal(diagonal(), true);
  const end = map.nodeAt(2, 2, 0);
  assert.equal(map.runSwimmable(origin, end), true);
  const state = { ...stateAt(origin), motion: { onGround: false, feetInLiquid: true, swimming: true } };
  const nav = new Navigation(map, state, end, 0);
  assert.deepEqual(nav.tick(state, 0).toward, { x: end.x, y: end.y, z: end.z }, 'an open swim run aims through intermediate checkpoints');
  for (const [x, z] of [
    [1, 0],
    [0, 1],
  ])
    for (let y = 0; y <= 2; y++) map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: [[x, y, z, x + 1, y + 1, z + 1]] });
  assert.equal(diagonal(), false);
  assert.equal(map.runSwimmable(origin, end), false, 'a merged swim must retain diagonal corner clearance');
});

test('a merged run over gentle steps keeps sprint until the final approach', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 5; x++) {
    column(map, x, 0);
    if (x > 0) map.put({ x, y: 0, z: 0, seenAt: Date.now(), traits: [], boxes: [[x, 0, 0, x + 1, 0.25, 1]] });
  }
  const state = { ...stateAt({ x: 0.5, y: 0, z: 0.5 }), vitals: { hunger: { current: 750, max: 1500 } } };
  const end = { x: 4.5, y: 0.25, z: 0.5, move: 'step' };
  const nav = new Navigation(map, state, { ...end, sprint: true }, 0);
  nav.adopt([{ x: 1.5, y: 0.25, z: 0.5, move: 'step' }, end], state.position, 0);
  assert.equal(nav.tick(state, 0).sprint, true);
  state.position = { x: 3.5, y: 0.25, z: 0.5 };
  assert.equal(nav.tick(state, 1000).sprint, false);
});

test('sprint continues through an intermediate point but slows for a sharp turn', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 8; x++) for (let z = 0; z <= 3; z++) column(map, x, z);
  for (const turn of [false, true]) {
    const state = { ...stateAt({ x: 3, y: 0, z: 0.5 }), vitals: { hunger: { current: 750, max: 1500 } } };
    const after = { x: turn ? 4.5 : 6.5, y: 0, z: turn ? 2.5 : 0.5, move: 'walk' };
    const nav = new Navigation(map, state, { ...after, sprint: true }, 0);
    nav.adopt([{ x: 4.5, y: 0, z: 0.5, move: 'walk' }, after], state.position, 0);
    nav.mergeRefused = true;
    assert.equal(nav.tick(state, 0).sprint, !turn);
  }
});

test('failed steps remain excluded in a new navigation leg and expire', () => {
  const map = new TerrainMemory();
  column(map, 0, 0);
  column(map, 1, 0);
  const state = stateAt({ x: 0.5, y: 0, z: 0.5 });
  const nav = new Navigation(map, state, { x: 1.5, y: 0, z: 0.5 }, 1000);
  nav.tick(state, 1000);
  nav.replan(state.position, 1100, 'stalled');
  const edge = '0,0,0>1,0,0';
  assert.ok(failedEdges(map, 1101).has(edge));
  const next = new Navigation(map, state, { x: 1.5, y: 0, z: 0.5 }, 1200);
  assert.ok(next.blocked.has(edge), 'a new target cannot retry the same failed step immediately');
  assert.equal(failedEdges(new TerrainMemory(), 1200).size, 0, 'another bot map is isolated');
  assert.equal(failedEdges(map, 61100).size, 0);
  failEdge(map, edge, Date.now());
  assert.equal(findRoute(map, state.position, { x: 1.5, y: 0, z: 0.5 }, 0.3, 1.85, { partial: false }), null);
});

test('thin full-width snow cover does not make buried cells navigation frontiers', () => {
  const map = new TerrainMemory();
  for (let x = -4; x <= 4; x++)
    for (let z = -4; z <= 4; z++) {
      map.put({ x, y: 0, z, seenAt: Date.now(), traits: [], code: 'game:snowlayer-1', boxes: [[x, 0, z, x + 1, 0.125, z + 1]] });
      for (let y = 1; y <= 4; y++) map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: [] });
    }
  map.put({ x: 0, y: -1, z: 0, seenAt: Date.now(), traits: ['plant'], code: 'game:aquatic-watercrowfoot-tip', boxes: [] });
  assert.equal(map.buried(0, -2, 0), true, 'a plant under the snow does not expose buried ground');
  assert.equal(map.frontier({ x: 0.5, y: 0.125, z: 0.5 }).size, 0, 'unknown ground under the snow cannot justify circling');
  assert.equal(map.get(0, -2, 0), undefined, 'the hidden block remains unknown');
  map.put({ x: 0, y: -1, z: 0, seenAt: Date.now(), traits: ['leaves'], code: 'game:leaves-grown7-birch', boxes: [] });
  assert.equal(map.buried(0, -2, 0), true, 'collisionless leaves beneath snow do not expose buried ground');
  assert.equal(map.buried(0, -7, 0), true, 'a tall bank still covers the low cells considered for drops');
});

test('water frontiers need the immediate bed but not impossible dry landings below it', () => {
  const map = new TerrainMemory();
  map.put({ x: 0, y: 0, z: 0, seenAt: Date.now(), traits: ['water'], boxes: [] });
  for (let y = 1; y <= 4; y++) map.put({ x: 0, y, z: 0, seenAt: Date.now(), traits: [], boxes: [] });
  const missing = new Map();
  map.levels(0, 0, 1, 1, 3, missing);
  assert.deepEqual([...missing.values()], [{ x: 0, y: -1, z: 0 }]);
});

test('new navigation legs retain visited frontiers until terrain evidence changes', () => {
  const map = new TerrainMemory();
  for (let x = 0; x <= 3; x++) column(map, x, 0);
  const start = { x: 0.5, y: 0, z: 0.5 },
    goal = { x: 10.5, y: 0, z: 0.5 };
  const end = findRoute(map, start, goal, 0.3, 1.85).at(-1);
  const missing = [...map.frontier(end).values()][0];
  const now = Date.now();
  visitFrontier(map, end, now);
  const nav = new Navigation(map, stateAt(start), goal, now);
  const next = findRoute(map, start, goal, 0.3, 1.85, { visits: nav.visits });
  assert.notDeepEqual(next?.at(-1), end, 'a restarted leg must not repeat the same viewpoint');
  assert.equal(visitedFrontiers(new TerrainMemory(), now).size, 0);
  assert.equal(visitedFrontiers(map, now + 60000).size, 0);
  visitFrontier(map, end, now);
  map.put({ ...missing, seenAt: now, traits: [], boxes: [] });
  assert.equal(visitedFrontiers(map, now).size, 0, 'new observed terrain permits reconsidering the viewpoint');
});

test('escape routing clears the hostile perimeter when the away heading is blocked', () => {
  const map = new TerrainMemory();
  for (let x = -40; x <= 0; x++) column(map, x, 0);
  const start = { x: 0.5, y: 0, z: 0.5 };
  const threat = { key: 'entity:1', code: 'game:bowtorn-surface', point: { x: 0.5, y: 9, z: 4.5 } };
  const state = { ...stateAt(start), nearbyEntities: [threat] };
  const nav = new Navigation(map, state, { x: -3.5, y: 0, z: 0.5 }, 0);
  nav.tick(state, 0);
  assert.equal(nav.evading, true);
  assert.ok(nav.target.z < start.z, 'the original away heading has no observed footing');
  assert.equal(nav.routeReaches, true, 'the observed lateral corridor reaches safety');
  assert.equal(clearanceRemaining(nav.route.at(-1), nav.target.clearOf), 0);
  assert.ok(nav.route.at(-1).x < -30, 'the route uses reachable ground beside the blocked heading');
  const first = nav.target.clearOf[0];
  assert.ok(
    clearanceRemaining(nav.route.at(-1), [first, { ...first, point: nav.route.at(-1) }]) > 0,
    'escaping one hostile cannot end beside another',
  );
});
