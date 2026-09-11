import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorationScore, Fieldwork, temporalStormUnsafe } from '../src/skills/fieldwork.mjs';
import { forageFoodCode, mushroomCode, ripeForage, safeFood, termiteCode } from '../src/skills/food.mjs';
import { accessibleForage, desperateFoodSightRange, foodSearchDistance, foodSightRange, foodViewChanged, harvestReady } from '../src/skills/survival.mjs';
import { fleeTarget, hostileEntity, nearestThreat } from '../src/skills/threats.mjs';
import { travel } from '../src/skills/travel.mjs';

const slot = code => ({ code, quantity: 1, nutrition: { saturation: 80, health: 0 },
  freshness: { state: 'fresh', freshHoursLeft: 100 } });

test('survival postpones only imminent and active temporal storms', () => {
  const state = phase => ({ condition: { temporalStorm: { phase } } });
  assert.equal(temporalStormUnsafe(state('clear')), false);
  assert.equal(temporalStormUnsafe(state('approaching')), false);
  assert.equal(temporalStormUnsafe(state('imminent')), true);
  assert.equal(temporalStormUnsafe(state('active')), true);
  assert.equal(temporalStormUnsafe({ condition: {} }), false);
});

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
  assert.equal(foodSightRange, 32);
  assert.equal(desperateFoodSightRange, 48);
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
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...wolf, point: { x: 8.5, y: -7, z: 10.5 } }] }), null);
  const bowtorn = { code: 'game:bowtorn-surface', point: { x: 8.5, y: 22, z: 10.5 } };
  assert.equal(nearestThreat({ position: player, nearbyEntities: [bowtorn] }), bowtorn);
  const target = fleeTarget(player, wolf);
  assert.ok(target.x > player.x + 30 && target.sprint && target.emergency);
});

test('stationary fieldwork accepts a blocked flee leg once the hostile is gone', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: .5 } };
  const state = { position: { x: .5, y: 1, z: .5 }, nearbyEntities: [wolf] };
  let destination;
  const field = new Fieldwork({});
  field.latest = state;
  field.walk = async target => {
    destination = target;
    field.latest = { ...state, nearbyEntities: [] };
    return { state: 'blocked', reason: 'terrain_changed' };
  };
  assert.equal(await field.evadeThreat(), true);
  assert.ok(destination.x > 32 && destination.sprint && destination.emergency);
});

test('stationary evasion yields its explicit flee leg as soon as the perimeter clears', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: .5 } };
  const state = { position: { x: .5, y: 1, z: .5 }, nearbyEntities: [wolf] };
  const field = new Fieldwork({});
  field.latest = state;
  field.walk = async (_, yieldWhen) => {
    assert.equal(yieldWhen(state), null);
    assert.equal(yieldWhen({ ...state, nearbyEntities: [] }), 'threat_cleared');
    field.latest = { ...state, nearbyEntities: [] };
    return { state: 'yielded' };
  };
  assert.equal(await field.evadeThreat(), true);
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

test('food recovery marks safe search legs as emergency sprint between ten and twenty percent', async () => {
  const state = { ok: true, alive: true, controlReady: true, mounted: false,
    player: { uid: 'test' }, position: { x: .5, y: 1, z: .5, dimension: 0 },
    body: { halfWidth: .3, height: 1.85 }, motion: { onGround: true, swimming: false, feetInLiquid: false },
    life: { alerts: ['low_food'], session: 'test', lastDamageAt: null }, orientation: { yawDegrees: 0 },
    vitals: { hunger: { current: 225, max: 1500 } } };
  let navigationTarget;
  const env = { send: async () => state, sync: async () => state,
    navigate: async target => { navigationTarget = target; return { state: 'arrived' }; } };
  const field = new Fieldwork(env, { now: () => 0 });
  field.initial = field.latest = state;
  field.recoveringFood = true;
  await field.walk({ x: 8.5, y: 1, z: .5 });
  assert.equal(navigationTarget.sprint, true);
  assert.equal(navigationTarget.emergency, true);
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

test('route recovery clears soft visit penalties and rotates deterministically', () => {
  const field = new Fieldwork({});
  field.latest = { position: { x: 32.5, z: -16.5 } };
  field.heading = 350;
  field.visits.set('old', 4);
  field.resetExploration();
  assert.deepEqual([...field.visits], [['2,-2', 1]]);
  assert.equal(field.heading, 35);
});

test('directed exploration bounds visit penalties below a backwards turn', () => {
  assert.ok(explorationScore(0, 1) > explorationScore(45, 0));
  assert.ok(explorationScore(0, 100) < explorationScore(180, 0));
  assert.equal(explorationScore(-45, 1), explorationScore(45, 1));
});

test('long travel extends a productive partial detour instead of reversing it', async () => {
  const initial = { position: { x: .5, y: 1, z: .5 }, condition: {} };
  const detour = { x: .5, y: 1, z: 48.5, horizontalOnly: true, arrivalRadius: 4 };
  const legs = [];
  let latest = initial, walks = 0, explores = 0;
  const field = {
    moved: 0,
    get latest() { return latest; },
    observe: async () => latest,
    report: () => {},
    explore: () => { explores++; return detour; },
    walk: async target => {
      legs.push(target);
      latest = ++walks === 1 ? { ...initial, position: { x: .5, y: 1, z: 10.5 } }
        : { ...initial, position: { x: 100.5, y: 1, z: .5 } };
      return { state: walks === 1 ? 'blocked' : 'arrived' };
    },
  };
  const result = await travel(field, null, { x: 100.5, z: .5 });
  assert.equal(result.ok, true);
  assert.equal(explores, 1);
  assert.deepEqual(legs, [detour, detour]);
});
