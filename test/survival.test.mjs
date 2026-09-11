import assert from 'node:assert/strict';
import { test } from 'node:test';
import { explorationDistance, explorationReach, explorationScore, Fieldwork, temporalStormUnsafe } from '../src/skills/fieldwork.mjs';
import { eatingLooks, forageFoodCode, mushroomCode, ripeForage, safeFood, termiteCode } from '../src/skills/food.mjs';
import { accessibleForage, desperateFoodSightRange, foodElevationDetourDistance, foodSearchDistance, foodSightRange, foodViewChanged, harvestReady, matchingFoodDrops, stalledFoodRoute, wideFoodSurveyNeeded } from '../src/skills/survival.mjs';
import { fleeTarget, hostileEntity, nearestThreat, nearestUnclearedThreat, threatClearDistance,
  threatClearRadius, threatStartDistance, threatStartRadius, threatVerticalRange } from '../src/skills/threats.mjs';
import { elevationDetourDistance, routeRegressed, travel } from '../src/skills/travel.mjs';
import { foliageBlock, foliageClearCandidate, threatAllowsClearance } from '../src/skills/clearance.mjs';

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

test('survival pickup recovery selects only exact verified food drops', () => {
  const point = { x: 10.5, z: 10.5 };
  const item = (code, quantity, x) => ({ kind: 'item', key: `entity:${x}`, code, quantity,
    point: { x, z: 10.5 } });
  assert.deepEqual(matchingFoodDrops([
    item('game:mushroom-witchhat-normal', 1, 14),
    item('game:mushroom-deathcap-normal', 1, 11),
    item('game:mushroom-witchhat-normal', null, 12),
    { ...item('game:mushroom-witchhat-normal', 1, 10), kind: 'block' },
    item('game:mushroom-witchhat-normal', 2, 13),
  ], 'game:mushroom-witchhat-normal', point).map(drop => drop.key), ['entity:13', 'entity:14']);
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
  assert.equal(wideFoodSurveyNeeded(.2), false);
  assert.equal(wideFoodSurveyNeeded(.199), true);
  assert.equal(foodElevationDetourDistance(1.49), 0);
  assert.equal(foodElevationDetourDistance(3), 6);
  assert.equal(foodElevationDetourDistance(20), foodSearchDistance);
});

test('food leads survive productive partial routes but quarantine stalled ones', () => {
  const blocked = { state: 'blocked' };
  assert.equal(stalledFoodRoute(blocked, { x: 0, z: 0 }, { x: 2.1, z: 0 }), false);
  assert.equal(stalledFoodRoute(blocked, { x: 0, z: 0 }, { x: 2, z: 0 }), true);
  assert.equal(stalledFoodRoute({ state: 'arrived' }, { x: 0, z: 0 }, { x: 0, z: 0 }), false);
});

test('threat avoidance is explicit, proximity-bounded and points away', () => {
  const player = { x: 10.5, y: 2, z: 10.5 };
  const wolf = { code: 'game:wolf-male', point: { x: 8.5, y: 2, z: 10.5 } };
  assert.equal(hostileEntity(wolf), true);
  assert.equal(hostileEntity({ ...wolf, code: 'game:chicken-hen' }), false);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [wolf] }), wolf);
  assert.equal(threatStartRadius, 20);
  assert.equal(threatClearRadius, 32);
  assert.equal(threatStartDistance('game:bowtorn-surface'), 36);
  assert.equal(threatClearDistance('game:bowtorn-surface'), 48);
  assert.equal(threatStartDistance('game:bear-brown-adult-male'), 28);
  assert.equal(threatClearDistance('game:bear-brown-adult-male'), 36);
  const boundaryWolf = { ...wolf, point: { x: -18, y: 2, z: 10.5 } };
  assert.equal(nearestThreat({ position: player, nearbyEntities: [boundaryWolf] }), null);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [boundaryWolf] }, threatClearRadius), boundaryWolf);
  assert.equal(nearestUnclearedThreat({ position: player, nearbyEntities: [boundaryWolf] }), boundaryWolf);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...wolf, point: { x: -22, z: 10.5 } }] }), null);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...wolf, code: 'game:locust-bronze',
    point: { x: 8.5, y: -7, z: 10.5 } }] }), null);
  const bowtorn = { code: 'game:bowtorn-surface', point: { x: 8.5, y: 22, z: 10.5 } };
  assert.equal(nearestThreat({ position: player, nearbyEntities: [bowtorn] }), bowtorn);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...bowtorn, point: { x: 46.5, y: 2, z: 10.5 } }] }).code,
    'game:bowtorn-surface');
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...bowtorn, point: { x: 47.5, y: 2, z: 10.5 } }] }), null);
  assert.equal(threatVerticalRange('game:bear-brown-adult-male'), 12);
  assert.equal(nearestThreat({ position: player, nearbyEntities: [{ ...wolf, code: 'game:bear-brown-adult-male',
    point: { x: 8.5, y: 11.5, z: 10.5 } }] })?.code, 'game:bear-brown-adult-male');
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

test('stationary evasion invokes its supplied deterministic clearance hook', async () => {
  const wolf = { code: 'game:wolf-male', point: { x: -4.5, y: 1, z: .5 } };
  const state = { position: { x: .5, y: 1, z: .5 }, nearbyEntities: [wolf] };
  const field = new Fieldwork({});
  field.latest = state;
  field.walk = async () => {
    field.latest = { ...state, nearbyEntities: [] };
    return { state: 'blocked', reason: 'no_observed_route' };
  };
  let cleared = 0;
  await field.evadeThreat(() => { cleared++; });
  assert.equal(cleared, 1);
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

test('a grounded route nudge is short, sneaking, deterministic and measured', async () => {
  const state = x => ({ ok: true, alive: true, controlReady: true, mounted: false,
    player: { uid: 'test' }, position: { x, y: 1, z: .5, dimension: 0 },
    body: { halfWidth: .3, height: 1.85 }, motion: { onGround: true, swimming: false, feetInLiquid: false },
    life: { alerts: [], session: 'test', lastDamageAt: null }, orientation: { yawDegrees: 0 },
    vitals: { hunger: { current: 1000, max: 1500 } }, nearbyEntities: [] });
  let latest = state(.1), aimed, movement;
  const env = {
    aim: async angles => { aimed = angles; },
    sync: async () => latest,
    send: async request => {
      if (request.action === 'observe') return latest;
      if (request.action === 'move') movement = request;
      if (request.action === 'stop') latest = state(.45);
      return { ok: true };
    },
  };
  const field = new Fieldwork(env, { wait: async () => {}, now: () => 0 });
  field.initial = field.latest = latest;
  assert.equal(await field.nudge({ x: 5.5, y: 1, z: .5 }), .35);
  assert.deepEqual(aimed, { yawDegrees: 90, pitchDegrees: 15 });
  assert.deepEqual(movement, { action: 'move', durationMs: 400, direction: 'forward',
    jump: false, sprint: false, sneak: true });
  assert.equal(field.moved, .35);
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

test('nearby travel explores after a stationary direct route failure', async () => {
  const initial = { position: { x: .5, y: 1, z: .5 }, condition: {} };
  const destination = { x: 20.5, y: 1, z: .5, horizontalOnly: true, arrivalRadius: 1 };
  const detour = { x: .5, y: 1, z: 12.5, horizontalOnly: true, arrivalRadius: 1 };
  const legs = [];
  let latest = initial, walks = 0;
  const field = {
    moved: 0,
    get latest() { return latest; },
    observe: async () => latest,
    report: () => {},
    explore: () => detour,
    walk: async target => {
      legs.push(target);
      walks++;
      if (walks === 2) latest = { ...initial, position: { x: .5, y: 1, z: 12.5 } };
      if (walks === 3) latest = { ...initial, position: { x: 20.5, y: 1, z: .5 } };
      return { state: walks === 1 ? 'blocked' : 'arrived' };
    },
  };
  const result = await travel(field, null, { x: 20.5, z: .5 });
  assert.equal(result.ok, true);
  assert.deepEqual(legs, [destination, detour, destination]);
});

test('nearby elevated travel gives its detour enough reach to find an ascent', async () => {
  const initial = { position: { x: .5, y: 1, z: .5 }, condition: {} };
  const destination = { x: 4.5, y: 11, z: .5, arrivalRadius: 1 };
  const detour = { x: .5, y: 1, z: 20.5, horizontalOnly: true, arrivalRadius: 2 };
  const legs = [];
  let latest = initial, walks = 0, explorationArgs;
  const field = {
    moved: 0,
    get latest() { return latest; },
    observe: async () => latest,
    report: () => {},
    explore: (...args) => { explorationArgs = args; return detour; },
    walk: async target => {
      legs.push(target);
      walks++;
      if (walks === 2) latest = { ...initial, position: { x: .5, y: 11, z: 20.5 } };
      if (walks === 3) latest = { ...initial, position: { x: 4.5, y: 11, z: .5 } };
      return { state: walks === 1 ? 'blocked' : 'arrived' };
    },
  };
  const result = await travel(field, null, destination);
  assert.equal(result.ok, true);
  assert.deepEqual(explorationArgs, [{ x: 4.5, y: 11, z: .5 }, 20, 20]);
  assert.deepEqual(legs, [destination, detour, destination]);
});

test('travel bounds regression from its best observed destination distance', () => {
  assert.equal(routeRegressed(100, 112), false);
  assert.equal(routeRegressed(100, 112.01), true);
  assert.equal(routeRegressed(100, 108, 8), false);
});

test('travel rebases its regression budget after yielding a failed route', async () => {
  const state = x => ({ position: { x, y: 1, z: .5 }, condition: {}, nearbyEntities: [] });
  const destination = { x: 100.5, z: .5 };
  const detour = { x: 48.5, y: 1, z: .5, horizontalOnly: true, arrivalRadius: 4 };
  let latest = state(.5), walks = 0, replacementReason;
  const field = {
    moved: 0,
    get latest() { return latest; },
    observe: async () => latest,
    report: () => {},
    explore: () => detour,
    penalize: () => {},
    walk: async (_target, yieldWhen) => {
      walks++;
      if (walks === 1) {
        assert.equal(yieldWhen(state(20.5)), null);
        latest = state(5.5);
        assert.equal(yieldWhen(latest), 'route_regressed');
        return { state: 'yielded', reason: 'route_regressed' };
      }
      replacementReason = yieldWhen(latest);
      latest = state(100.5);
      return { state: 'arrived', reason: 'destination_reached' };
    },
  };
  const result = await travel(field, null, destination);
  assert.equal(result.ok, true);
  assert.equal(walks, 2);
  assert.equal(replacementReason, null);
});

test('foliage clearance selects only a reachable body-level leaf toward the goal', () => {
  const state = { position: { x: .5, y: 1, z: .5 }, body: { height: 1.85 } };
  const object = (key, code, x, y, z, yaw, extra = {}) => ({ kind: 'block', key, code,
    point: { x, y, z }, look: { yawDegrees: yaw }, withinPickingRange: true,
    access: { buildOrBreak: true }, ...extra });
  const forward = object('forward', 'game:leaves-grown-oak', .5, 2, 2.5, 0);
  const side = object('side', 'game:leavesbranchy-grown-oak', 2.5, 2, .5, 90);
  assert.equal(foliageBlock(forward), true);
  assert.equal(foliageBlock(object('log', 'game:log-grown-oak-ud', .5, 2, 2.5, 0)), false);
  assert.equal(foliageClearCandidate([side, forward], state, { x: .5, z: 10.5 }), forward);
  const nearSide = object('near-side', 'game:leaves-grown-oak', 1.5, 2, .5, 90);
  assert.equal(foliageClearCandidate([forward, nearSide], state, { x: .5, z: 10.5 }), forward);
  const farForward = object('far-forward', 'game:leaves-grown-oak', .5, 2, 4.5, 0);
  assert.equal(foliageClearCandidate([farForward, nearSide], state, { x: .5, z: 10.5 }), nearSide);
  assert.equal(foliageClearCandidate([forward, side], state, { x: .5, z: 10.5 }, new Set(['forward'])), side);
  assert.equal(foliageClearCandidate([{ ...forward, withinPickingRange: false }], state, { x: .5, z: 10.5 }), null);
  assert.equal(threatAllowsClearance(state, { point: { x: 12.5, z: .5 } }), true);
  assert.equal(threatAllowsClearance(state, { point: { x: 12.49, z: .5 } }), false);
});
