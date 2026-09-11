import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fieldwork } from '../src/skills/fieldwork.mjs';
import { forageFoodCode, mushroomCode, ripeForage, safeFood } from '../src/skills/food.mjs';
import { accessibleForage, harvestReady } from '../src/skills/survival.mjs';

const slot = code => ({ code, quantity: 1, nutrition: { saturation: 80, health: 0 },
  freshness: { state: 'fresh', freshHoursLeft: 100 } });

test('deterministic forage allowlist rejects poisonous and psychedelic mushrooms', () => {
  assert.equal(mushroomCode('game:mushroom-chanterelle-normal'), true);
  assert.equal(mushroomCode('game:mushroom-deathcap-normal'), false);
  assert.equal(mushroomCode('game:mushroom-goldcap-normal'), false);
  assert.equal(safeFood(slot('game:mushroom-chanterelle-normal')), true);
  assert.equal(safeFood(slot('game:mushroom-deathcap-normal')), false);
  assert.equal(safeFood({ ...slot('game:mushroom-chanterelle-normal'), nutrition: { saturation: 80, health: -1 } }), false);
  assert.equal(ripeForage({ kind: 'block', forage: { ripe: true, foodCode: 'game:mushroom-chanterelle-normal' } }), true);
});

test('only mature crops with verified raw food drops are actionable', () => {
  const crop = (cropType, stage) => ({ kind: 'block', forage: { kind: 'crop', cropType, stage } });
  assert.equal(ripeForage(crop('carrot', 5)), false);
  assert.equal(ripeForage(crop('carrot', 6)), true);
  assert.equal(forageFoodCode(crop('carrot', 6)), 'game:vegetable-carrot');
  assert.equal(ripeForage(crop('cassava', 9)), false);
  assert.equal(ripeForage(crop('soybean', 11)), false);
  assert.equal(safeFood(slot('game:vegetable-carrot')), true);
  assert.equal(safeFood(slot('game:rawcassava-raw')), false);
});

test('forage planning skips targets denied by cached server access', () => {
  const mushroom = { forage: { kind: 'mushroom', foodCode: 'game:mushroom-chanterelle-normal' } };
  const berries = { forage: { kind: 'berry', foodCode: 'game:fruit-blueberry' } };
  assert.equal(accessibleForage({ ...mushroom, access: { buildOrBreak: false, use: true } }), false);
  assert.equal(accessibleForage({ ...berries, access: { buildOrBreak: true, use: false } }), false);
  assert.equal(accessibleForage({ ...mushroom, access: { buildOrBreak: true, use: false } }), true);
  assert.equal(accessibleForage(berries), true);
});

test('breakable forage is harvested beside its drop, never at maximum reach or underfoot', () => {
  const mushroom = { withinPickingRange: true, point: { x: 10.5, y: 2.1, z: 10.5 },
    forage: { kind: 'mushroom', foodCode: 'game:mushroom-chanterelle-normal' } };
  assert.equal(harvestReady(mushroom, { x: 8.9, z: 10.5 }), false);
  assert.equal(harvestReady(mushroom, { x: 9.5, z: 10.5 }), true);
  assert.equal(harvestReady(mushroom, { x: 10.2, z: 10.3 }), false);
});

test('low health is tolerated only during explicit starving food recovery', () => {
  const field = new Fieldwork({});
  const state = alerts => ({ life: { alerts } });
  assert.equal(field.alertsSafe(state(['low_food'])), true);
  assert.equal(field.alertsSafe(state(['low_food', 'low_health'])), false);
  field.recoveringFood = true;
  assert.equal(field.alertsSafe(state(['low_food', 'low_health'])), true);
  assert.equal(field.alertsSafe(state(['low_health'])), false);
  assert.equal(field.alertsSafe(state(['low_food', 'on_fire'])), false);
});

test('a blocked exploration leg penalizes its destination for the next deterministic choice', async () => {
  const state = { ok: true, alive: true, controlReady: true, mounted: false,
    player: { uid: 'test' },
    position: { x: .5, y: 1, z: .5, dimension: 0 }, body: { halfWidth: .3, height: 1.85 },
    motion: { onGround: true, swimming: false, feetInLiquid: false },
    life: { alerts: [], session: 'test', lastDamageAt: null },
    orientation: { yawDegrees: 0 } };
  const env = { send: async () => state, sync: async () => state,
    navigate: async () => ({ state: 'blocked', reason: 'terrain_changed' }) };
  const field = new Fieldwork(env, { now: () => 0 });
  field.latest = field.initial = state;
  const target = { x: 20.5, y: 1, z: .5 };
  await field.walk(target);
  assert.equal(field.visits.get('1,0'), 1);
});
