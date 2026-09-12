import assert from 'node:assert/strict';
import { test } from 'node:test';
import { elevationDetourDistance, routeRegressed, travel } from '../src/goals/travel.ts';
import { remember } from '../src/support/facts.ts';
import { explorationDistance, explorationReach, explorationScore, Fieldwork, temporalStormUnsafe } from '../src/support/fieldwork.ts';
import { eatingLooks, edible, foodYield, safeFood } from '../src/support/food.ts';
import { leafBlock, leafClearCandidate, threatAllowsLeafClearing } from '../src/support/leaf-clearing.ts';
import {
  accessibleForage,
  desperateFoodSightRange,
  exhaustedFoodLead,
  foodElevationDetourDistance,
  foodLeadGuarded,
  foodRecoverySatisfied,
  foodSearchBias,
  foodSearchDistance,
  foodSightRange,
  foodViewChanged,
  harvestReady,
  matchingFoodDrops,
  Survival,
  stuckFoodRoute,
  unproductiveFoodApproach,
  wideFoodSurveyNeeded,
} from '../src/support/survival.ts';
import {
  fleeTarget,
  hostileEntity,
  nearestThreat,
  nearestUnclearedThreat,
  threatClearDistance,
  threatClearRadius,
  threatStartDistance,
  threatStartRadius,
  threatVerticalRange,
} from '../src/support/threats.ts';

const slot = code => ({ code, quantity: 1, nutrition: { saturation: 80, health: 0 }, freshness: { state: 'fresh', freshHoursLeft: 100 } });

test('survival postpones only imminent and active temporal storms', () => {
  const state = phase => ({ condition: { temporalStorm: { phase } } });
  assert.equal(temporalStormUnsafe(state('clear')), false);
  assert.equal(temporalStormUnsafe(state('approaching')), false);
  assert.equal(temporalStormUnsafe(state('imminent')), true);
  assert.equal(temporalStormUnsafe(state('active')), true);
  assert.equal(temporalStormUnsafe({ condition: {} }), false);
});

const page = (code, extra = {}) => remember(code, { ok: true, code, ...extra });
const food = { saturation: 80, health: 0 };

test('edibility is read from the tooltip, never from a list of codes', () => {
  assert.equal(safeFood(slot('game:mushroom-chanterelle-normal')), true);
  assert.equal(safeFood(slot('game:bread-spelt-perfect')), true);
  assert.equal(safeFood({ ...slot('game:mushroom-deathcap-normal'), nutrition: { saturation: 80, health: -2 } }), false);
  assert.equal(safeFood({ ...slot('game:mushroom-goldcap-normal'), nutrition: { saturation: 80, health: 0, psychedelic: 1 } }), false);
  assert.equal(safeFood({ ...slot('game:fruit-blueberry'), freshness: { state: 'spoiling' } }), false);
  assert.equal(safeFood({ ...slot('game:stick'), nutrition: null }), false);
  assert.equal(edible(undefined), false);
});

test('eating searches a deterministic three-dimensional clear-air grid', () => {
  const looks = eatingLooks();
  assert.equal(looks.length, 40);
  assert.deepEqual(looks.slice(0, 5), [
    { yawDegrees: 0, pitchDegrees: -60 },
    { yawDegrees: 45, pitchDegrees: -60 },
    { yawDegrees: 90, pitchDegrees: -60 },
    { yawDegrees: 135, pitchDegrees: -60 },
    { yawDegrees: 180, pitchDegrees: -60 },
  ]);
  assert.deepEqual(looks.at(-1), { yawDegrees: 315, pitchDegrees: 60 });
});

test('a block is forage when the pages read say it yields food now', () => {
  page('game:fruit-blueberry', { nutrition: food });
  page('game:fruitingbush-grown-blueberry-free', { harvest: { drops: [{ code: 'game:fruit-blueberry' }], requiresGrowth: 'ripe' }, drops: [] });
  const bush = growth => ({ kind: 'block', code: 'game:fruitingbush-grown-blueberry-free', facts: { growth } });
  assert.deepEqual(foodYield(bush('ripe')), { code: 'game:fruit-blueberry', how: 'use' });
  assert.equal(foodYield(bush('flowering')), null);
  page('game:mushroom-chanterelle-normal', { nutrition: food, drops: [{ code: 'game:mushroom-chanterelle-normal' }] });
  page('game:mushroom-deathcap-normal', { nutrition: { saturation: 80, health: -2 }, drops: [{ code: 'game:mushroom-deathcap-normal' }] });
  assert.deepEqual(foodYield({ kind: 'block', code: 'game:mushroom-chanterelle-normal' }), {
    code: 'game:mushroom-chanterelle-normal',
    how: 'break',
  });
  assert.equal(foodYield({ kind: 'block', code: 'game:mushroom-deathcap-normal' }), null);
  page('game:seeds-carrot', {});
  page('game:vegetable-carrot', { nutrition: food });
  page('game:crop-carrot-5', { drops: [{ code: 'game:seeds-carrot' }] });
  page('game:crop-carrot-6', { drops: [{ code: 'game:seeds-carrot' }, { code: 'game:vegetable-carrot' }] });
  assert.equal(foodYield({ kind: 'block', code: 'game:crop-carrot-5' }), null);
  assert.deepEqual(foodYield({ kind: 'block', code: 'game:crop-carrot-6' }), { code: 'game:vegetable-carrot', how: 'break' });
  assert.equal(foodYield({ kind: 'block', code: 'game:crop-cassava-9' }), null, 'an unread page yields nothing');
});

test('forage planning skips targets denied by cached server access', () => {
  page('game:mushroom-chanterelle-normal', { nutrition: food, drops: [{ code: 'game:mushroom-chanterelle-normal' }] });
  page('game:fruit-blueberry', { nutrition: food });
  page('game:fruitingbush-grown-blueberry-free', { harvest: { drops: [{ code: 'game:fruit-blueberry' }], requiresGrowth: 'ripe' } });
  const mushroom = { kind: 'block', code: 'game:mushroom-chanterelle-normal' };
  const berries = { kind: 'block', code: 'game:fruitingbush-grown-blueberry-free', facts: { growth: 'ripe' } };
  assert.equal(accessibleForage({ ...mushroom, access: { buildOrBreak: false, use: true } }), false);
  assert.equal(accessibleForage({ ...berries, access: { buildOrBreak: true, use: false } }), false);
  assert.equal(accessibleForage({ ...mushroom, access: { buildOrBreak: true, use: false } }), true);
  assert.equal(accessibleForage(berries), true);
});

test('breakable forage is harvested beside its drop, never at maximum reach or underfoot', () => {
  page('game:mushroom-chanterelle-normal', { nutrition: food, drops: [{ code: 'game:mushroom-chanterelle-normal' }] });
  const mushroom = { kind: 'block', code: 'game:mushroom-chanterelle-normal', withinPickingRange: true, point: { x: 10.5, y: 2.1, z: 10.5 } };
  assert.equal(harvestReady(mushroom, { x: 8.9, z: 10.5 }), false);
  assert.equal(harvestReady(mushroom, { x: 9.5, z: 10.5 }), true);
  assert.equal(harvestReady(mushroom, { x: 10.2, z: 10.3 }), false);
  // A diagonal corner overlap still occupies the native body cell.
  assert.equal(harvestReady(mushroom, { x: 9.77, z: 11.26 }, 0.3), false);
});

test('survival pickup recovery selects only exact verified food drops', () => {
  const point = { x: 10.5, z: 10.5 };
  const item = (code, quantity, x) => ({ kind: 'item', key: `entity:${x}`, code, quantity, point: { x, z: 10.5 } });
  assert.deepEqual(
    matchingFoodDrops(
      [
        item('game:mushroom-witchhat-normal', 1, 14),
        item('game:mushroom-deathcap-normal', 1, 11),
        item('game:mushroom-witchhat-normal', null, 12),
        { ...item('game:mushroom-witchhat-normal', 1, 10), kind: 'block' },
        item('game:mushroom-witchhat-normal', 2, 13),
      ],
      'game:mushroom-witchhat-normal',
      point,
    ).map(drop => drop.key),
    ['entity:13', 'entity:14'],
  );
});

test('food exploration uses observed local steps and does not rescan an unchanged distant cone', () => {
  assert.equal(foodSearchDistance, 24);
  assert.equal(foodSightRange, 32);
  assert.equal(desperateFoodSightRange, 48);
  const view = { position: { x: 10, z: 10 }, yawDegrees: 30 };
  const state = (x, z, yawDegrees) => ({ position: { x, z }, orientation: { yawDegrees } });
  assert.equal(foodViewChanged(view, state(11.9, 10, 44.9)), false);
  assert.equal(foodViewChanged(view, state(12.1, 10, 30)), true);
  assert.equal(foodViewChanged(view, state(10, 10, 46)), true);
  assert.equal(foodViewChanged(view, state(10, 10, 350)), true);
  assert.equal(wideFoodSurveyNeeded(0.2), false);
  assert.equal(wideFoodSurveyNeeded(0.199), true);
  assert.equal(foodElevationDetourDistance(1.49), 0);
  assert.equal(foodElevationDetourDistance(3), 6);
  assert.equal(foodElevationDetourDistance(20), foodSearchDistance);
});

test('food leads survive productive partial routes but skip stuck ones', () => {
  const blocked = { state: 'blocked' };
  assert.equal(stuckFoodRoute(blocked, { x: 0, z: 0 }, { x: 2.1, z: 0 }), false);
  assert.equal(stuckFoodRoute(blocked, { x: 0, z: 0 }, { x: 2, z: 0 }), true);
  assert.equal(stuckFoodRoute({ state: 'arrived' }, { x: 0, z: 0 }, { x: 0, z: 0 }), false);
  const target = { point: { x: 10, z: 0 } };
  assert.equal(unproductiveFoodApproach(target, blocked, { x: 0, z: 0 }, { x: 2.1, z: 0 }), false);
  assert.equal(unproductiveFoodApproach(target, blocked, { x: 0, z: 0 }, { x: 2, z: 0 }), true);
  assert.equal(unproductiveFoodApproach(target, blocked, { x: 2, z: 0 }, { x: 1, z: 0 }), true);
  assert.equal(unproductiveFoodApproach(target, { state: 'paused', reason: 'threat_near_food' }, { x: 0, z: 0 }, { x: 4, z: 0 }), false);
  assert.equal(unproductiveFoodApproach(target, { state: 'arrived' }, { x: 0, z: 0 }, { x: 0, z: 0 }), false);
});

test('a predator pauses a food route before navigation can carry it into danger', () => {
  const survival = new Survival(null);
  const state = {
    position: { x: 0, y: 0, z: 0 },
    vitals: { hunger: { current: 100, max: 1000 } },
    nearbyEntities: [],
  };
  assert.equal(survival.pauseFoodWalk(state), null);
  state.nearbyEntities.push({ code: 'game:wolf-eurasian-adult-male', point: { x: 10, y: 0, z: 0 } });
  assert.equal(survival.pauseFoodWalk(state), 'threat_near_food');
  survival.reserve = 80;
  assert.equal(survival.pauseFoodWalk(state), 'food_available');
});

test('only food inside a predator perimeter is abandoned', () => {
  const target = distance => ({ point: { x: distance, y: 0, z: 0 } });
  const wolf = { code: 'game:wolf-eurasian-adult-male', point: { x: 0, y: 0, z: 0 } };
  assert.equal(foodLeadGuarded(target(threatClearDistance(wolf.code)), wolf), true);
  assert.equal(foodLeadGuarded(target(threatClearDistance(wolf.code) + 0.1), wolf), false);
  assert.equal(foodLeadGuarded(target(1), null), false);
});

test('food search drops an unreachable habitat bias after two stationary legs', () => {
  const destination = { x: 20, z: 20 };
  const habitat = { x: 10, z: 10 };
  assert.equal(foodSearchBias(0, destination, habitat), destination);
  assert.equal(foodSearchBias(1, null, habitat), habitat);
  assert.equal(foodSearchBias(2, destination, habitat), null);
});

test('an unseen remembered food lead expires after reaching its approach cell', () => {
  assert.equal(exhaustedFoodLead({ visible: false }, { state: 'arrived' }), true);
  assert.equal(exhaustedFoodLead({ visible: true }, { state: 'arrived' }), false);
  assert.equal(exhaustedFoodLead({ visible: false }, { state: 'paused' }), false);
});

test('recalled blocks enter the goal working set even when the sighting is old', () => {
  const remembered = {
    kind: 'block',
    key: 'block:0:10:1:10:game:fruitingbush-wild-blueberry-free',
    code: 'game:fruitingbush-wild-blueberry-free',
    point: { x: 10.5, y: 1.5, z: 10.5 },
    ageMs: 8 * 60 * 60 * 1000,
  };
  const field = new Fieldwork(
    {
      sightings: { view: () => [remembered] },
    },
    { now: () => 1000 },
  );
  field.latest = {
    capabilities: ['sightings'],
    position: { x: 0.5, y: 1, z: 0.5 },
    body: { eyeHeight: 1.6 },
    pickingRange: 4.5,
  };
  assert.deepEqual(field.recall(128, ['bush'], 'blocks'), [remembered]);
  assert.equal(field.targets(object => object.key === remembered.key).length, 1);
});

test('threat avoidance is explicit, proximity-bounded and points away', () => {
  const player = { x: 10.5, y: 2, z: 10.5 };
  const wolf = { code: 'game:wolf-male', point: { x: 8.5, y: 2, z: 10.5 } };
  assert.equal(hostileEntity(wolf), true);
  assert.equal(hostileEntity({ ...wolf, code: 'game:chicken-hen' }), false);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [wolf] }), wolf);
  assert.equal(threatStartRadius, 16);
  assert.equal(threatClearRadius, 28);
  assert.equal(threatStartDistance('game:bowtorn-surface'), 28);
  assert.equal(threatClearDistance('game:bowtorn-surface'), 36);
  assert.equal(threatStartDistance('game:bear-brown-adult-male'), 22);
  assert.equal(threatClearDistance('game:bear-brown-adult-male'), 30);
  assert.equal(hostileEntity({ code: 'game:wolf-eurasian-baby-female' }), false, 'the young are not hunters');
  const boundaryWolf = { ...wolf, point: { x: -16, y: 2, z: 10.5 } };
  assert.equal(nearestThreat({ position: player, nearbyEntities: [boundaryWolf] }), null);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [boundaryWolf] }, threatClearRadius), boundaryWolf);
  assert.equal(nearestUnclearedThreat({ position: player, nearbyEntities: [boundaryWolf] }), boundaryWolf);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...wolf, point: { x: -22, z: 10.5 } }] }), null);
  assert.equal(
    nearestThreat({ position: player, nearbyEntities: [{ ...wolf, code: 'game:locust-bronze', point: { x: 8.5, y: -7, z: 10.5 } }] }),
    null,
  );
  const bowtorn = { code: 'game:bowtorn-surface', point: { x: 8.5, y: 22, z: 10.5 } };
  assert.equal(nearestThreat({ position: player, nearbyEntities: [bowtorn] }), bowtorn);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...bowtorn, point: { x: 38.5, y: 2, z: 10.5 } }] }).code, 'game:bowtorn-surface');
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...bowtorn, point: { x: 39.5, y: 2, z: 10.5 } }] }), null);
  assert.equal(threatVerticalRange('game:bear-brown-adult-male'), 12);
  assert.equal(
    nearestThreat({ position: player, nearbyEntities: [{ ...wolf, code: 'game:bear-brown-adult-male', point: { x: 8.5, y: 11.5, z: 10.5 } }] })?.code,
    'game:bear-brown-adult-male',
  );
  const target = fleeTarget(player, wolf);
  assert.ok(target.x > player.x + 30 && target.sprint && target.emergency);
});

test('stationary fieldwork accepts a blocked flee leg once the hostile is gone', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: 0.5 } };
  const state = { position: { x: 0.5, y: 1, z: 0.5 }, nearbyEntities: [wolf] };
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

test('stationary evasion invokes its supplied deterministic unstick hook', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: 0.5 } };
  const state = { position: { x: 0.5, y: 1, z: 0.5 }, nearbyEntities: [wolf] };
  const field = new Fieldwork({});
  field.latest = state;
  field.walk = async () => {
    field.latest = { ...state, nearbyEntities: [] };
    return { state: 'blocked', reason: 'no_observed_route' };
  };
  let cleared = 0;
  await field.evadeThreat(() => {
    cleared++;
  });
  assert.equal(cleared, 1);
});

test('stationary evasion pauses its explicit flee leg as soon as the perimeter clears', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: 0.5 } };
  const state = { position: { x: 0.5, y: 1, z: 0.5 }, nearbyEntities: [wolf] };
  const field = new Fieldwork({});
  field.latest = state;
  field.walk = async (_, pauseWhen) => {
    assert.equal(pauseWhen(state), null);
    assert.equal(pauseWhen({ ...state, nearbyEntities: [] }), 'threat_cleared');
    field.latest = { ...state, nearbyEntities: [] };
    return { state: 'paused' };
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

test('successful food recovery resumes travel without waiting for a local stockpile', () => {
  assert.equal(foodRecoverySatisfied(0.599, 0, 8), false);
  assert.equal(foodRecoverySatisfied(0.6, 0, 1), true);
  assert.equal(foodRecoverySatisfied(0.8, 320, 0), true);
  assert.equal(foodRecoverySatisfied(0.8, 0, 0), false);
});

test('food recovery marks safe search legs as emergency sprint between ten and twenty percent', async () => {
  const state = {
    ok: true,
    alive: true,
    controlReady: true,
    mounted: false,
    player: { uid: 'test' },
    position: { x: 0.5, y: 1, z: 0.5, dimension: 0 },
    body: { halfWidth: 0.3, height: 1.85 },
    motion: { onGround: true, swimming: false, feetInLiquid: false },
    life: { alerts: ['low_food'], session: 'test', lastDamageAt: null },
    orientation: { yawDegrees: 0 },
    vitals: { hunger: { current: 225, max: 1500 } },
  };
  let navigationTarget;
  const env = {
    send: async () => state,
    sync: async () => state,
    navigate: async target => {
      navigationTarget = target;
      return { state: 'arrived' };
    },
  };
  const field = new Fieldwork(env, { now: () => 0 });
  field.initial = field.latest = state;
  field.recoveringFood = true;
  await field.walk({ x: 8.5, y: 1, z: 0.5 });
  assert.equal(navigationTarget.sprint, true);
  assert.equal(navigationTarget.emergency, true);
});

test('critical food recovery does not stop to glean unrelated supplies', async () => {
  const state = {
    ok: true,
    alive: true,
    controlReady: true,
    mounted: false,
    player: { uid: 'test' },
    position: { x: 0.5, y: 1, z: 0.5, dimension: 0 },
    body: { halfWidth: 0.3, height: 1.85 },
    motion: { onGround: true, swimming: false, feetInLiquid: false },
    life: { alerts: ['low_food'], session: 'test', lastDamageAt: null },
    orientation: { yawDegrees: 0 },
    vitals: { hunger: { current: 0, max: 1500 } },
  };
  let pauseReason;
  const env = {
    send: async () => state,
    sync: async () => state,
    navigate: async (_target, pauseWhen) => {
      pauseReason = pauseWhen(state);
      return { state: pauseReason ? 'paused' : 'arrived' };
    },
  };
  const field = new Fieldwork(env, { now: () => 0 });
  field.initial = field.latest = state;
  field.recoveringFood = true;
  let gleaned = 0;
  field.gleaner = { pauseWhen: () => 'want_in_reach', tend: async () => gleaned++ };
  await field.walk({ x: 8.5, y: 1, z: 0.5 });
  assert.equal(pauseReason, null);
  assert.equal(gleaned, 0);
});

test('a blocked exploration leg penalizes its destination for the next deterministic choice', async () => {
  const state = {
    ok: true,
    alive: true,
    controlReady: true,
    mounted: false,
    player: { uid: 'test' },
    position: { x: 0.5, y: 1, z: 0.5, dimension: 0 },
    body: { halfWidth: 0.3, height: 1.85 },
    motion: { onGround: true, swimming: false, feetInLiquid: false },
    life: { alerts: [], session: 'test', lastDamageAt: null },
    orientation: { yawDegrees: 0 },
  };
  const env = { send: async () => state, sync: async () => state, navigate: async () => ({ state: 'blocked', reason: 'terrain_changed' }) };
  const field = new Fieldwork(env, { now: () => 0 });
  field.latest = field.initial = state;
  const target = { x: 20.5, y: 1, z: 0.5 };
  await field.walk(target);
  assert.equal(field.places.failed(target), 1);
});

test('route recovery turns the heading and keeps what it knows of the places', () => {
  const field = new Fieldwork({});
  field.latest = { position: { x: 32.5, z: -16.5 } };
  field.heading = 350;
  field.places.fail({ x: 100, z: 100 });
  field.resetExploration();
  assert.equal(field.places.failed({ x: 100, z: 100 }), 1, 'what is known of the places stays known');
  assert.equal(field.heading, 35);
});

test('directed exploration bounds visit penalties below a backwards turn', () => {
  assert.ok(explorationScore(0, 1) > explorationScore(45, 0));
  assert.ok(explorationScore(0, 100) < explorationScore(180, 0));
  assert.equal(explorationScore(-45, 1), explorationScore(45, 1));
});

test('directed exploration keeps lateral and reverse bypasses local', () => {
  assert.equal(explorationDistance(48, 0), 48);
  assert.equal(explorationDistance(48, 45), 36);
  assert.ok(Math.abs(explorationDistance(48, -90) - 19.2) < 1e-9);
  assert.ok(Math.abs(explorationDistance(48, 180) - 9.6) < 1e-9);
});

test('elevation travel searches beyond a horizontally close cliff face', () => {
  assert.equal(elevationDetourDistance(1.49), 0);
  assert.equal(elevationDetourDistance(1.5), 12);
  assert.equal(elevationDetourDistance(10), 20);
  assert.equal(elevationDetourDistance(100), 24);
  assert.equal(explorationReach(4, 48), 4);
  assert.equal(explorationReach(4, 20, 20), 20);
  assert.equal(explorationReach(4, 10, 20), 10);
});

test('long travel extends a productive partial detour instead of reversing it', async () => {
  const initial = { position: { x: 0.5, y: 1, z: 0.5 }, condition: {} };
  const detour = { x: 0.5, y: 1, z: 48.5, horizontalOnly: true, arrivalRadius: 4 };
  const legs = [];
  let latest = initial,
    walks = 0,
    explores = 0;
  const field = {
    moved: 0,
    get latest() {
      return latest;
    },
    observe: async () => latest,
    report: () => {},
    explore: () => {
      explores++;
      return detour;
    },
    walk: async target => {
      legs.push(target);
      latest = ++walks === 1 ? { ...initial, position: { x: 0.5, y: 1, z: 10.5 } } : { ...initial, position: { x: 100.5, y: 1, z: 0.5 } };
      return { state: walks === 1 ? 'blocked' : 'arrived' };
    },
  };
  const result = await travel(field, null, { x: 100.5, z: 0.5 });
  assert.equal(result.ok, true);
  assert.equal(explores, 1);
  assert.deepEqual(legs, [detour, detour]);
});

test('nearby travel explores after a stationary direct route failure', async () => {
  const initial = { position: { x: 0.5, y: 1, z: 0.5 }, condition: {} };
  const destination = { x: 20.5, y: 1, z: 0.5, horizontalOnly: true, arrivalRadius: 1 };
  const detour = { x: 0.5, y: 1, z: 12.5, horizontalOnly: true, arrivalRadius: 1 };
  const legs = [];
  let latest = initial,
    walks = 0;
  const field = {
    moved: 0,
    get latest() {
      return latest;
    },
    observe: async () => latest,
    report: () => {},
    explore: () => detour,
    walk: async target => {
      legs.push(target);
      walks++;
      if (walks === 2) latest = { ...initial, position: { x: 0.5, y: 1, z: 12.5 } };
      if (walks === 3) latest = { ...initial, position: { x: 20.5, y: 1, z: 0.5 } };
      return { state: walks === 1 ? 'blocked' : 'arrived' };
    },
  };
  const result = await travel(field, null, { x: 20.5, z: 0.5 });
  assert.equal(result.ok, true);
  assert.deepEqual(legs, [destination, detour, destination]);
});

test('nearby elevated travel gives its detour enough reach to find an ascent', async () => {
  const initial = { position: { x: 0.5, y: 1, z: 0.5 }, condition: {} };
  const destination = { x: 4.5, y: 11, z: 0.5, arrivalRadius: 1 };
  const detour = { x: 0.5, y: 1, z: 20.5, horizontalOnly: true, arrivalRadius: 2 };
  const legs = [];
  let latest = initial,
    walks = 0,
    explorationArgs;
  const field = {
    moved: 0,
    get latest() {
      return latest;
    },
    observe: async () => latest,
    report: () => {},
    explore: (...args) => {
      explorationArgs = args;
      return detour;
    },
    walk: async target => {
      legs.push(target);
      walks++;
      if (walks === 2) latest = { ...initial, position: { x: 0.5, y: 11, z: 20.5 } };
      if (walks === 3) latest = { ...initial, position: { x: 4.5, y: 11, z: 0.5 } };
      return { state: walks === 1 ? 'blocked' : 'arrived' };
    },
  };
  const result = await travel(field, null, destination);
  assert.equal(result.ok, true);
  assert.deepEqual(explorationArgs, [{ x: 4.5, y: 11, z: 0.5 }, 20, 20]);
  assert.deepEqual(legs, [destination, detour, destination]);
});

test('travel bounds regression from its best observed destination distance', () => {
  assert.equal(routeRegressed(100, 112), false);
  assert.equal(routeRegressed(100, 112.01), true);
  assert.equal(routeRegressed(100, 108, 8), false);
});

test('travel rebases its regression budget after pausing a failed route', async () => {
  const state = x => ({ position: { x, y: 1, z: 0.5 }, condition: {}, nearbyEntities: [] });
  const destination = { x: 100.5, z: 0.5 };
  const detour = { x: 48.5, y: 1, z: 0.5, horizontalOnly: true, arrivalRadius: 4 };
  let latest = state(0.5),
    walks = 0,
    replacementReason;
  const field = {
    moved: 0,
    get latest() {
      return latest;
    },
    observe: async () => latest,
    report: () => {},
    explore: () => detour,
    penalize: () => {},
    walk: async (_target, pauseWhen) => {
      walks++;
      if (walks === 1) {
        assert.equal(pauseWhen(state(20.5)), null);
        latest = state(5.5);
        assert.equal(pauseWhen(latest), 'route_regressed');
        return { state: 'paused', reason: 'route_regressed' };
      }
      replacementReason = pauseWhen(latest);
      latest = state(100.5);
      return { state: 'arrived', reason: 'destination_reached' };
    },
  };
  const result = await travel(field, null, destination);
  assert.equal(result.ok, true);
  assert.equal(walks, 2);
  assert.equal(replacementReason, null);
});

test('leaf clearing selects only a reachable body-level leaf toward the goal', () => {
  const state = { position: { x: 0.5, y: 1, z: 0.5 }, body: { height: 1.85 } };
  const object = (key, code, x, y, z, yaw, extra = {}) => ({
    kind: 'block',
    key,
    code,
    point: { x, y, z },
    look: { yawDegrees: yaw },
    withinPickingRange: true,
    access: { buildOrBreak: true },
    ...extra,
  });
  const forward = object('forward', 'game:leaves-grown-oak', 0.5, 2, 2.5, 0);
  const side = object('side', 'game:leavesbranchy-grown-oak', 2.5, 2, 0.5, 90);
  assert.equal(leafBlock(forward), true);
  assert.equal(leafBlock(object('log', 'game:log-grown-oak-ud', 0.5, 2, 2.5, 0)), false);
  assert.equal(leafClearCandidate([side, forward], state, { x: 0.5, z: 10.5 }), forward);
  const nearSide = object('near-side', 'game:leaves-grown-oak', 1.5, 2, 0.5, 90);
  assert.equal(leafClearCandidate([forward, nearSide], state, { x: 0.5, z: 10.5 }), forward);
  const farForward = object('far-forward', 'game:leaves-grown-oak', 0.5, 2, 4.5, 0);
  assert.equal(leafClearCandidate([farForward, nearSide], state, { x: 0.5, z: 10.5 }), nearSide);
  assert.equal(leafClearCandidate([forward, side], state, { x: 0.5, z: 10.5 }, new Set(['forward'])), side);
  const behind = object('behind', 'game:leaves-grown-oak', 0.5, 2, -0.5, 180);
  assert.equal(leafClearCandidate([behind], state, { x: 0.5, z: 10.5 }), null);
  assert.equal(leafClearCandidate([behind, forward], state, { x: 0.5, z: 10.5 }), forward);
  assert.equal(leafClearCandidate([{ ...forward, withinPickingRange: false }], state, { x: 0.5, z: 10.5 }), null);
  assert.equal(threatAllowsLeafClearing(state, { point: { x: 12.5, z: 0.5 } }), true);
  assert.equal(threatAllowsLeafClearing(state, { point: { x: 12.49, z: 0.5 } }), false);
});
