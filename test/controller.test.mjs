import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Controller } from '../src/controller/runtime.mjs';
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
    if (request.action === 'control_frame') { resolveFrame(); if (failFrame) throw Error('lost acknowledgement'); }
    return { ok: true };
  };
  return { controller: new Controller(send), calls, frame, state };
}

test('Node geometry preserves step, headroom and hole constraints', () => {
  const map = new TerrainMemory(); map.apply(terrain());
  const start = { x: .5, y: 0, z: .5 }, end = { x: 2.5, y: 0, z: .5 };
  assert.ok(findRoute(map, start, end, .3, 1.85));
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
  assert.equal(calls.filter(c => c.action === 'control_frame').length, 1);
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
