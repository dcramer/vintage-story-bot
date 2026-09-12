import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Navigation } from '../src/runtime/navigation/navigator.ts';
import { distance, TerrainMemory } from '../src/runtime/navigation/terrain.ts';

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
