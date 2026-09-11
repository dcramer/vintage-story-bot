import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fieldwork } from '../src/skills/fieldwork.mjs';
import { forageFoodCode, mushroomCode, ripeForage, safeFood, termiteCode } from '../src/skills/food.mjs';
import { accessibleForage, foodSearchDistance, foodSightRange, foodViewChanged, harvestReady } from '../src/skills/survival.mjs';
import { fleeTarget, hostileEntity, nearestThreat } from '../src/skills/threats.mjs';

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

test('installed termite mounds are deterministic safe breakable forage', () => {
  const termites = { kind: 'block', forage: { kind: 'termites', ripe: true,
    foodCode: 'game:insect-termite' }, access: { buildOrBreak: true } };
  assert.equal(termiteCode('game:insect-termite'), true);
  assert.equal(termiteCode('game:insect-grub'), false);
  assert.equal(ripeForage(termites), true);
  assert.equal(accessibleForage(termites), true);
  assert.equal(safeFood(slot('game:insect-termite')), true);
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
  // A diagonal corner overlap still occupies the native body cell.
  assert.equal(harvestReady(mushroom, { x: 9.77, z: 11.26 }, .3), false);
});

test('food exploration uses observed local steps and does not rescan an unchanged distant cone', () => {
  assert.equal(foodSearchDistance, 12);
  assert.equal(foodSightRange, 16);
  const view = { position: { x: 10, z: 10 }, yawDegrees: 30 };
  const state = (x, z, yawDegrees) => ({ position: { x, z }, orientation: { yawDegrees } });
  assert.equal(foodViewChanged(view, state(11.9, 10, 44.9)), false);
  assert.equal(foodViewChanged(view, state(12.1, 10, 30)), true);
  assert.equal(foodViewChanged(view, state(10, 10, 46)), true);
  assert.equal(foodViewChanged(view, state(10, 10, 350)), true);
});

test('threat avoidance is explicit, proximity-bounded and points away', () => {
  const player = { x: 10.5, y: 2, z: 10.5 };
  const wolf = { code: 'game:wolf-male', point: { x: 8.5, y: 2, z: 10.5 } };
  assert.equal(hostileEntity(wolf), true);
  assert.equal(hostileEntity({ ...wolf, code: 'game:chicken-hen' }), false);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [wolf] }), wolf);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...wolf, point: { x: -22, z: 10.5 } }] }), null);
  const target = fleeTarget(player, wolf);
  assert.ok(target.x > player.x + 30 && target.sprint && target.emergency);
});

test('stationary fieldwork routes away from a nearby hostile before acting', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: .5 } };
  const state = { position: { x: .5, y: 1, z: .5 }, nearbyEntities: [wolf] };
  let destination;
  const field = new Fieldwork({});
  field.latest = state;
  field.walk = async target => { destination = target; return { state: 'arrived' }; };
  assert.equal(await field.evadeThreat(), true);
  assert.ok(destination.x > 32 && destination.sprint && destination.emergency);
});

test('low-health food recovery remains authorized after eating clears low food', () => {
  const field = new Fieldwork({});
  const state = alerts => ({ life: { alerts } });
  assert.equal(field.alertsSafe(state(['low_food'])), true);
  assert.equal(field.alertsSafe(state(['low_food', 'low_health'])), false);
  field.recoveringFood = true;
  assert.equal(field.alertsSafe(state(['low_food', 'low_health'])), true);
  assert.equal(field.alertsSafe(state(['low_health'])), true);
  assert.equal(field.alertsSafe(state(['low_food', 'on_fire'])), false);
  field.recoveringFood = false;
  assert.equal(field.alertsSafe(state(['low_health'])), false);
  const fresh = new Fieldwork({});
  fresh.recoveringFood = true;
  assert.equal(fresh.alertsSafe(state(['low_health'])), false);
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
