import test from 'node:test';
import assert from 'node:assert/strict';
import { contiguousTrails, markRespawnBreaks } from '../report/trail.mjs';

test('map trails break at respawn without splitting ordinary mission changes', () => {
  const points = [
    { at: 100, x: 0, z: 0, dimension: 0 },
    { at: 200, x: 4, z: 0, dimension: 0 },
    { at: 400, x: 60, z: 70, dimension: 0 },
    { at: 500, x: 64, z: 70, dimension: 0 },
  ];
  const log = [{ at: 300, topic: 'action', data: { action: 'respawn', ok: true } }];
  assert.deepEqual(contiguousTrails(points, log).map(trail => trail.length), [2, 2]);
  assert.equal(markRespawnBreaks(points, log), true);
  assert.equal(points[2].discontinuity, 'respawn');
  assert.deepEqual(contiguousTrails(points).map(trail => trail.length), [2, 2]);
});
