import assert from 'node:assert/strict';
import { test } from 'node:test';
import { remember } from '../src/support/facts.ts';
import { Fieldwork } from '../src/support/fieldwork.ts';
import { forageScore } from '../src/support/food.ts';
import { Places } from '../src/support/places.ts';
import { chooseFrontier, Search } from '../src/support/search.ts';

const at = { x: 0.5, y: 100, z: 0.5 };
const surface = points => ({ columns: new Map(points.map(([x, z, kind]) => [`${x},${z}`, { x, z, y: 100, kind }])) });

test('forage considers nearby habitat and alternatives beyond the nearest habitat', () => {
  const places = new Places();
  const nearby = chooseFrontier(at, 0, {
    places,
    habitats: ['edge'],
    surface: surface([
      [0, 20, 'ground'],
      [1, 20, 'canopy'],
    ]),
  });
  assert.equal(nearby.z, 20.5, 'a visible edge inside 53 blocks is worth inspecting');
  const alternative = chooseFrontier(at, 0, {
    places,
    habitats: ['edge'],
    surface: surface([
      [0, -20, 'ground'],
      [1, -20, 'canopy'],
      [0, 30, 'ground'],
      [1, 30, 'canopy'],
    ]),
  });
  assert.equal(alternative.z, 30.5, 'a nearest edge behind us must not hide the edge ahead');
});

test('search effort changes exploration without making terrain impassable or hiding real food', () => {
  let now = 0;
  const places = new Places(() => now);
  for (let z = 8; z <= 160; z += 8) places.search('food', { x: 0.5, z: z + 0.5 });
  assert.notEqual(chooseFrontier(at, 0, { places, kind: 'food' }).heading, 0);
  assert.equal(chooseFrontier(at, 0, { places, kind: 'stick' }).heading, 0);
  assert.equal(places.failed({ x: 0.5, z: 16.5 }), 0);
  now += 20 * 60 * 1000 + 1;
  assert.equal(chooseFrontier(at, 0, { places, kind: 'food' }).heading, 0);
});

test('walking and repeated failed harvests cannot renew the food budget', async () => {
  let now = 0,
    taken = false;
  const field = new Fieldwork({ places: new Places(() => now) }, { now: () => now });
  field.latest = { position: { ...at }, orientation: { yawDegrees: 0 }, nearbyEntities: [] };
  field.report = () => {};
  const target = { key: 'berries', code: 'bush', point: { ...at }, withinPickingRange: true };
  field.scan = async () => [target];
  const search = new Search(field, {
    kind: 'food',
    match: ['bush'],
    wanted: () => true,
    take: async () => taken,
    budget: { distance: 100, timeMs: 1000 },
  });
  await search.step();
  assert.equal(search.unproductive, 1, 'a failed take is not progress');
  now = 1001;
  assert.equal(search.exhausted(), true, 'failed take did not renew the clock');
  assert.equal(search.budgetReason, 'time_without_take');
  field.skipped.clear();
  taken = true;
  await search.step();
  assert.equal(search.exhausted(), false, 'a verified take renews the budget');
  for (const x of [30, 60, 90, 120]) search.pause({ ...field.latest, position: { ...at, x } });
  field.latest.position = { ...at, x: 120 };
  assert.equal(search.exhausted(), true, 'distance is bounded during the walk, before the leg returns');
  assert.equal(search.budgetReason, 'distance_without_take');
  assert.equal(field.places.failed(field.latest.position), 0);
});

test('empty terrain triggers new viewpoints, a changed direction, then a bounded none_found', async () => {
  let now = 0;
  const phases = [];
  const field = new Fieldwork({ places: new Places(() => now) }, { now: () => now });
  field.latest = { position: { ...at }, orientation: { yawDegrees: 0 }, nearbyEntities: [] };
  field.heading = 0;
  field.report = phase => phases.push(phase);
  field.scan = async () => [];
  field.lookAround = async () => [];
  field.recall = () => [];
  field.explore = point => point;
  let viewpoints = 0;
  field.walk = async (target, pause) => {
    const p = field.latest.position;
    const distance = Math.hypot(target.x - p.x, target.z - p.z);
    const dx = (target.x - p.x) / distance,
      dz = (target.z - p.z) / distance;
    for (let step = 0; step < distance; step++) {
      now += 100;
      field.latest.position = { ...field.latest.position, x: field.latest.position.x + dx, z: field.latest.position.z + dz };
      const reason = pause(field.latest);
      if (reason) {
        if (reason === 'search_viewpoint') viewpoints++;
        return { state: 'paused', reason };
      }
    }
    return { state: 'arrived' };
  };
  const search = new Search(field, {
    kind: 'food',
    match: ['bush'],
    wanted: () => true,
    take: async () => false,
    budget: { distance: 384, timeMs: 360000 },
  });
  let steps = 0;
  while (!search.exhausted() && steps++ < 30) await search.step();
  assert.ok(viewpoints >= 10, 'long exploration is interrupted for repeated scans');
  assert.ok(phases.includes('search_redirected'), 'empty travel changes the heading');
  assert.ok(steps < 30, 'moving continuously still ends the search');
  assert.equal(search.budgetReason, 'distance_without_take');
  assert.ok(search.withoutTake < 386);
});

test('food leads weigh expected satiety and approach effort without favoring poison', () => {
  const make = (name, saturation, quantity, x, health = 0) => {
    remember(`${name}-fruit`, { nutrition: { saturation, health } });
    remember(name, { harvest: { drops: [{ code: `${name}-fruit`, quantity }] } });
    return { code: name, point: { ...at, x } };
  };
  const small = make('small', 20, 1, 8);
  const patch = make('patch', 80, 3, 16);
  const harmful = make('harmful', 80, 3, 8, -1);
  assert.ok(forageScore(patch, at) < forageScore(small, at));
  assert.equal(forageScore(harmful, at), Infinity);
  assert.ok(forageScore(harmful, at, 1) > forageScore(patch, at, 1));
  assert.ok(forageScore({ ...patch, point: { ...patch.point, y: 120 } }, at) > forageScore(patch, at));
});
