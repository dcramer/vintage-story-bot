import assert from 'node:assert/strict';
import test from 'node:test';
import { contiguousTrails, markRespawnBreaks, recentTrail, trimTrail } from '../report/trail.mjs';

test('map trails break at respawn without splitting ordinary mission changes', () => {
  const points = [
    { at: 100, x: 0, z: 0, dimension: 0 },
    { at: 200, x: 4, z: 0, dimension: 0 },
    { at: 400, x: 60, z: 70, dimension: 0 },
    { at: 500, x: 64, z: 70, dimension: 0 },
  ];
  const log = [{ at: 300, topic: 'action', data: { action: 'respawn', ok: true } }];
  assert.deepEqual(
    contiguousTrails(points, log).map(trail => trail.length),
    [2, 2],
  );
  assert.equal(markRespawnBreaks(points, log), true);
  assert.equal((points[2] as any).discontinuity, 'respawn');
  assert.deepEqual(
    contiguousTrails(points).map(trail => trail.length),
    [2, 2],
  );
});

test('map trails keep only a bounded recent window', () => {
  const points = [
    { at: 100, x: 0, z: 0 },
    { at: 700, x: 1, z: 0 },
    { at: 800, x: 2, z: 0 },
    { at: 900, x: 3, z: 0 },
  ];
  assert.deepEqual(
    recentTrail(points, 1000, 300, 2).map(point => point.at),
    [800, 900],
  );
  assert.equal(points.length, 4);
  assert.equal(trimTrail(points, 1000, 300, 2), true);
  assert.deepEqual(
    points.map(point => point.at),
    [800, 900],
  );
  assert.equal(trimTrail(points, 1000, 300, 2), false);
});
