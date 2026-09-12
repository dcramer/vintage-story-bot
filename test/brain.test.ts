import assert from 'node:assert/strict';
import { test } from 'node:test';
import brain, {
  decide as decision,
  environmentalHurt,
  fresh,
  HURT_CLASSIFY_MS,
  kit,
  pickJob,
  SHELTER_DIRT,
  STICK_MIN,
} from '../src/brain/default.ts';
import { shelter as shelterCells } from '../src/support/structures.ts';

const decide = (reading, memory): any => decision(reading, memory);

import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BrainLoop } from '../src/runtime/brain.ts';

const slot = (code, quantity = 1, extra = {}) => ({ slot: 0, code, quantity, ...extra });
const inventory = (...slots) => ({
  ok: true,
  inventories: [
    { name: 'hotbar', slots: slots.map((s, i) => ({ ...s, slot: i })) },
    { name: 'backpack', slots: [] },
  ],
});
const state = (extra = {}) => ({
  ok: true,
  alive: true,
  position: { x: 0, y: 100, z: 0 },
  nearbyEntities: [],
  vitals: { hunger: { current: 1200, max: 1500 } },
  condition: {},
  ...extra,
});
const day = { calendar: { daylight: 1 } },
  night = { calendar: { daylight: 0.1 } };
// A pack with the three tools: the kit's first three tasks done.
const kitted = () =>
  inventory(
    slot('game:knife-generic-flint', 1, { tool: 'Knife', durability: 5 }),
    slot('game:axe-flint', 1, { tool: 'Axe', durability: 5 }),
    slot('game:shovel-flint', 1, { tool: 'Shovel', durability: 5 }),
  );
const reading = (extra = {}) => ({
  state: state(),
  inventory: inventory(),
  environment: day,
  active: null,
  last: null,
  events: [],
  markers: [],
  ground: null,
  terrain: null,
  now: 1000,
  ...extra,
});
const situation = (extra = {}) => ({
  burrowed: false,
  dangerHere: false,
  body: false,
  threat: false,
  hurt: false,
  storm: false,
  hunger: 0.8,
  reserve: 0,
  night: false,
  home: true,
  atHome: true,
  sticks: 10,
  knife: true,
  axe: true,
  shovel: true,
  stone: false,
  torches: 2,
  grass: 0,
  dirt: 0,
  logs: 8,
  storage: true,
  full: false,
  surplus: 0,
  short: 0,
  stashKnife: true,
  ...extra,
});

test('brain: danger, hunger and night come before the kit, and the kit comes in day-1 order', () => {
  assert.equal(pickJob(situation({ threat: true, hunger: 0.1 })), 'hide');
  assert.equal(pickJob(situation({ threat: true, burrowed: true })), 'wait', 'visible threats cannot lure the bot out of a sealed burrow');
  assert.equal(pickJob(situation({ hurt: true, burrowed: true })), 'unburrow', 'actual damage opens an escape from the unsafe burrow');
  assert.equal(pickJob(situation({ storm: true, atHome: false })), 'go_home');
  assert.equal(pickJob(situation({ storm: true, home: false })), 'burrow', 'a storm sends a homeless bot underground');
  assert.equal(pickJob(situation({ storm: true, home: false, burrowed: true })), 'wait', 'an existing burrow shelters from a storm');
  assert.equal(pickJob(situation({ hunger: 0.1, night: true, reserve: 100 })), 'eat', 'the pack is eaten from at night');
  assert.equal(pickJob(situation({ hunger: 0.1, night: true, atHome: false })), 'eat', 'critical hunger cannot wait for day');
  assert.equal(
    pickJob(situation({ hunger: 0.1, night: true, reserve: 100, burrowed: true })),
    'eat',
    'dug in with food in the pack: eat where it sits',
  );
  assert.equal(
    pickJob(situation({ hunger: 0.1, night: true, reserve: 0, burrowed: true })),
    'unburrow',
    'dug in with nothing to eat: open the burrow to search',
  );
  const starvingNight = fresh();
  starvingNight.job = 'burrow';
  const digging = decide(
    reading({
      environment: night,
      state: state({ vitals: { hunger: { current: 0, max: 1500 } } }),
      active: { id: 'b', kind: 'burrow', state: 'running', by: 'brain' },
    }),
    starvingNight,
  );
  assert.equal(digging.wait, 'letting burrow finish', 'hunger with nothing to eat does not cut the night dig-in short');
  starvingNight.job = 'burrow';
  assert.equal(
    decide(
      reading({
        environment: night,
        state: state({ nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }] }),
        active: { id: 'b', kind: 'burrow', state: 'running', by: 'brain' },
      }),
      starvingNight,
    ).wait,
    'letting burrow finish',
    'a wolf does not cut the dig-in short either',
  );
  starvingNight.job = 'sticks';
  assert.deepEqual(
    decide(reading({ environment: night, active: { id: 's', kind: 'gather', state: 'running', by: 'brain' } }), starvingNight),
    { stop: 'burrow' },
    'night falling cuts a kit job short',
  );
  assert.equal(pickJob(situation({ hunger: 0.35 })), 'eat', 'peckish with an empty pack: go find food');
  assert.equal(pickJob(situation({ hunger: 0.35, reserve: 200 })), 'explore', 'peckish with food in the pack: carry on');
  assert.equal(pickJob(situation({ dangerHere: true, night: true })), 'relocate', 'a place full of scares is left');
  assert.equal(pickJob(situation({ night: true, atHome: false })), 'go_home');
  assert.equal(pickJob(situation({ night: true, home: false, dirt: 0 })), 'burrow', 'night without a home: dig in where it stands');
  assert.equal(pickJob(situation({ night: true, home: false, dirt: 3 })), 'burrow');
  assert.equal(pickJob(situation({ night: true, home: false, burrowed: true })), 'wait');
  assert.equal(pickJob(situation({ home: false, burrowed: true })), 'unburrow');
  assert.equal(pickJob(situation({ home: false, dirt: SHELTER_DIRT })), 'shelter');
  assert.equal(pickJob(situation({ home: false })), 'dirt');
  assert.equal(pickJob(situation({ home: false, sticks: 3 })), 'dirt', 'ten sticks wait for a home: the shovel needed only one');
  assert.equal(pickJob(situation({ home: false, shovel: false, stone: true })), 'shovel', 'a shovel before digging dirt');
  assert.equal(pickJob(situation({ knife: false, sticks: 0 })), 'knife', 'the knife first, whatever else is short');
  assert.equal(pickJob(situation({ knife: false, axe: false, stone: true })), 'knife');
  assert.equal(pickJob(situation({ axe: false, stone: true })), 'axe');
  assert.equal(pickJob(situation({ stashKnife: false })), 'spare_knife', 'a spare knife for the basket once the kit is in hand');
  assert.equal(pickJob(situation({ torches: 0 })), 'grass');
  assert.equal(pickJob(situation({ torches: 0, grass: 2 })), 'torches');
  assert.equal(pickJob(situation({ logs: 1 })), 'logs');
  assert.equal(pickJob(situation()), 'explore');
  assert.equal(pickJob(situation({ body: true, sticks: 0 })), 'recover', 'the body comes before the rest of the kit');
  assert.equal(pickJob(situation({ body: true, knife: false })), 'knife', 'but the knife comes before the body: two quick goals before a long walk');
  assert.equal(pickJob(situation({ body: true, night: true })), 'wait', 'but not at night');
  assert.equal(pickJob(situation({ body: true, sticks: 0 }), new Set(['recover'] as any)), 'sticks', 'a failed recovery is set aside');
  assert.equal(
    pickJob(situation({ home: false, shovel: false }), new Set(['shovel'] as any)),
    'explore',
    'a set-aside job holds back what depends on it; the ladder goes exploring',
  );
});

test('brain: a threat interrupts its own goal, a failed job is set aside, a finished shelter becomes home', () => {
  const memory = fresh();
  memory.notes.home = { x: 0, y: 100, z: 0 };
  const first = decide(reading({ inventory: inventory(slot('game:stick', 2)) }), memory);
  assert.deepEqual([first.start, first.args.match, memory.job], ['gather', 'looseflints', 'knife'], 'a stick in hand: flint for the knife next');
  const wolf = state({ nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }] });
  assert.deepEqual(decide(reading({ state: wolf, active: { id: 'g1', kind: 'gather', state: 'running', by: 'brain' } }), memory), {
    stop: 'threat',
  });
  const handoff = decide(
    reading({ last: { id: 'g1', kind: 'gather', ok: false, reason: 'brain: threat' }, state: state({ orientation: { yawDegrees: 0 } }), now: 1001 }),
    memory,
  );
  assert.equal(handoff.start, 'travel', 'a predator cancellation becomes a flight even when the predator leaves the next observation');
  assert.ok(handoff.args.x < 0, 'the flight keeps the predator position and runs away from it');
  memory.job = 'sticks';
  decide(
    reading({ inventory: inventory(slot('game:stick', 2)), last: { id: 'g1', kind: 'gather', ok: false, reason: 'blocked' }, now: 2000 }),
    memory,
  );
  assert.notEqual(memory.job, 'sticks', 'a failed stick search is set aside around here');
  const grave = [{ guid: 'g', title: 'You died here', icon: 'gravestone', position: { x: 30, y: 100, z: 0 } }];
  assert.equal(
    decide(reading({ markers: grave, inventory: kitted(), now: 2500 }), memory).start,
    'retrieve_body',
    'a death marker sends it back for its things',
  );
  memory.job = null;
  const fled = decide(reading({ state: wolf }), memory);
  assert.equal(fled.start, 'travel');
  assert.equal(
    decide(reading({ active: { id: 'f', kind: 'travel', state: 'running', by: 'brain' }, now: 2600 }), memory).wait,
    'letting travel finish',
    'a flight goes on while the scare is fresh',
  );
  const far = { ...state(), position: { x: 40, y: 100, z: 0 } };
  assert.deepEqual(decide(reading({ state: far, active: { id: 'f', kind: 'travel', state: 'running', by: 'brain' }, now: 30000 }), memory), {
    stop: 'safe',
  });
  memory.job = null;
  const fledAgain = decide(reading({ state: wolf, now: 31000 }), memory);
  assert.equal(fledAgain.start, 'travel');

  assert.equal(fled.start, 'travel');
  const again = decide(reading({ state: wolf, last: { id: 'g2', kind: 'travel', ok: false, reason: 'interrupted' }, now: 3000 }), memory);
  assert.equal(again.start, 'travel', 'a failed flight is tried again at once');
  const shelterMemory = fresh();
  const tools = [
    slot('game:stick', 10),
    slot('game:knife-generic-flint', 1, { tool: 'Knife', durability: 5 }),
    slot('game:axe-flint', 1, { tool: 'Axe', durability: 5 }),
    slot('game:shovel-flint', 1, { tool: 'Shovel', durability: 5 }),
  ];
  const dirt = inventory(slot('game:soil-medium-none', SHELTER_DIRT), ...tools);
  const walls = decide(reading({ inventory: dirt }), shelterMemory);
  assert.deepEqual([walls.start, walls.args.item, shelterMemory.job], ['shelter', 'game:soil-medium-none', 'shelter']);
  assert.equal(shelterCells({ x: 0, y: 0, z: 0 }, 'd').length, 23);
  const home = { x: 3.5, y: 100, z: 0.5 };
  decide(reading({ inventory: dirt, last: { id: 's1', kind: 'shelter', ok: true, result: { home } } }), shelterMemory);
  assert.deepEqual(shelterMemory.notes.home, home);
});

test('brain: a flight hands daywork back only after landing', () => {
  const memory = fresh();
  memory.job = 'hide';
  const airborne = state({ motion: { onGround: false, swimming: false } });
  assert.deepEqual(
    decide(
      reading({
        state: airborne,
        last: { id: 'flight', kind: 'travel', ok: false, reason: 'brain: safe' },
      }),
      memory,
    ),
    { wait: 'settling after movement' },
  );
  assert.equal(decide(reading({ state: state({ motion: { onGround: true, swimming: false } }) }), memory).start, 'gather');
});

test('brain: a transient ungrounded start does not set a kit job aside', () => {
  const memory = fresh();
  memory.job = 'knife';
  const next = decide(
    reading({
      inventory: inventory(slot('game:stick', STICK_MIN)),
      last: { id: 'flint', kind: 'gather', ok: false, reason: 'Start grounded' },
    }),
    memory,
  );
  assert.equal(memory.tried.knife, undefined);
  assert.equal(next.start, 'gather');
  assert.equal(next.args.match, 'looseflints');
});

test('brain: danger interrupts body recovery and backs it off across a flight', () => {
  const grave = [{ guid: 'g', title: 'You died here', icon: 'gravestone', position: { x: 0, y: 100, z: 0 } }];
  const memory = fresh();
  memory.job = 'recover';
  const wolf = state({
    position: { x: 40, y: 100, z: 0 },
    nearbyEntities: [{ code: 'game:wolf-male', point: { x: 45, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }],
  });
  assert.deepEqual(
    decide(reading({ markers: grave, state: wolf, active: { id: 'body', kind: 'retrieve_body', state: 'running', by: 'brain' } }), memory),
    {
      stop: 'threat',
    },
  );
  const afterDanger = decide(
    reading({
      markers: grave,
      state: state({ position: { x: 40, y: 100, z: 0 } }),
      last: { id: 'body', kind: 'retrieve_body', ok: false, reason: 'brain: threat' },
      now: 2000,
    }),
    memory,
  );
  assert.equal(afterDanger.start, 'travel', 'finishes escaping before returning to ordinary work');
  assert.ok(afterDanger.args.x < 40, 'continues away from the predator that interrupted recovery');
  assert.ok(memory.tried.recover, 'the recovery is set aside');

  memory.job = null;
  const afterFlight = decide(reading({ markers: grave, state: state({ position: { x: 100, y: 100, z: 0 } }), now: 3000 }), memory);
  assert.equal(afterFlight.start, 'gather', 'the recovery cooldown follows the bot away from the grave');

  memory.job = null;
  const retry = decide(
    reading({ markers: grave, inventory: kitted(), state: state({ position: { x: 100, y: 100, z: 0 } }), now: 2001 + 5 * 60 * 1000 }),
    memory,
  );
  assert.equal(retry.start, 'retrieve_body', 'the grave is tried again after the cooldown');

  const clusteredDanger = fresh();
  clusteredDanger.job = 'recover';
  decide(reading({ markers: grave, last: { id: 'body', kind: 'retrieve_body', ok: false, reason: 'brain: relocate' }, now: 4000 }), clusteredDanger);
  assert.ok(clusteredDanger.tried.recover, 'relocating from a dangerous grave also backs recovery off');
});

test('brain: a hit from nowhere is danger, and copper seen in passing is marked once and told', () => {
  const memory = fresh();
  const hurt = [{ id: 1, at: 1, type: 'hurt', health: 10 }];
  const running = { id: 'o1', kind: 'travel', state: 'running', by: 'operator' };
  assert.deepEqual(decide(reading({ events: hurt, active: running, now: 1000 }), memory), { wait: 'identifying damage source' });
  assert.deepEqual(
    decide(reading({ active: running, now: 1000 + HURT_CLASSIFY_MS + 1 }), memory),
    { stop: 'hurt' },
    "unexplained damage stops anyone's goal after the cause grace period",
  );
  const interrupted = fresh();
  interrupted.job = 'sticks';
  const afterStop = decide(
    reading({ last: { id: 'g1', kind: 'gather', ok: false, reason: 'brain: hurt' }, state: state({ orientation: { yawDegrees: 0 } }) }),
    interrupted,
  );
  assert.equal(afterStop.start, 'travel', 'the stop reason survives the event cursor and produces a flight');
  assert.ok(afterStop.args.z > 20, 'runs straight ahead when there is no home to run to');
  const nugget = {
    id: 2,
    at: 1,
    type: 'sighted',
    kind: 'block',
    key: 'block:0:10:100:5:game:looseores-nativecopper-granite',
    code: 'game:looseores-nativecopper-granite',
    point: { x: 10.5, y: 100, z: 5.5 },
  };
  const mark = decide(reading({ events: [nugget], active: running }), memory);
  assert.deepEqual(
    mark.act.map(a => a.action),
    ['add_map_waypoint', 'chat'],
    'marks and tells without stopping the walk',
  );
  assert.deepEqual([mark.act[0].title, mark.act[0].x, mark.act[0].z], ['Copper', 10, 5]);
  const again = decide(reading({ events: [nugget], active: running }), memory);
  assert.ok('wait' in again, 'the same nugget is not marked twice');
  const marked = [{ guid: 'g', title: 'Copper', icon: 'rocks', position: { x: 20, y: 100, z: 5 } }];
  const near = decide(reading({ events: [{ ...nugget, key: 'k2' }], markers: marked }), fresh());
  assert.ok(!('act' in near), 'a marker already nearby means no new one');
});

test('brain: death waits out a temporal storm before respawning', () => {
  const dead = state({
    alive: false,
    life: { deathId: 'death-1', canRespawn: true },
    condition: { temporalStorm: { phase: 'active' } },
  });
  assert.deepEqual(decide(reading({ state: dead }), fresh()), { wait: 'dead, waiting out temporal storm' });
  assert.deepEqual(decide(reading({ state: { ...dead, condition: {} } }), fresh()), {
    act: [{ action: 'respawn', deathId: 'death-1' }],
    why: 'dead',
  });
});

test('brain: death waits until the respawn dialog is ready', () => {
  const dead = state({ alive: false, life: { deathId: 'death-1', canRespawn: false } });
  assert.deepEqual(decide(reading({ state: dead }), fresh()), { wait: 'dead, waiting for respawn' });
});

test('brain: death forgets transient burrow and pit state before respawn', () => {
  const memory = fresh();
  memory.burrow = { x: 10, y: 100, z: 10 };
  memory.pit = { x: 18, y: 98, z: 10 };
  memory.startupChecked = true;
  const dead = state({ alive: false, life: { deathId: 'death-1', canRespawn: true } });
  decide(reading({ state: dead }), memory);
  assert.equal(memory.burrow, null);
  assert.equal(memory.pit, null);
  assert.equal(memory.startupChecked, false, 'the new spawn is inspected for its own terrain state');
});

test('brain: a fall is not mistaken for an unseen attacker', () => {
  const fall = [
    { id: 1, at: 1, type: 'hurt', health: 10 },
    { id: 2, at: 2, type: 'message', text: 'Lost 3.64 hp through gravity', kind: 'Notification' },
  ];
  assert.equal(environmentalHurt(fall), true);
  const memory = fresh();
  memory.job = 'sticks';
  const running = { id: 'g1', kind: 'gather', state: 'running', by: 'brain' };
  assert.deepEqual(decide(reading({ events: fall, active: running }), memory), { wait: 'letting gather finish' });
  const delayed = fresh();
  delayed.job = 'sticks';
  assert.deepEqual(decide(reading({ events: fall.slice(0, 1), active: running, now: 1000 }), delayed), { wait: 'identifying damage source' });
  assert.deepEqual(
    decide(reading({ events: fall.slice(1), active: running, now: 1500 }), delayed),
    { wait: 'letting gather finish' },
    'a gravity notification arriving after the raw hit preserves the running goal',
  );
  assert.deepEqual(
    decide(reading({ active: running, now: 1000 + HURT_CLASSIFY_MS + 1000 }), delayed),
    { wait: 'letting gather finish' },
    'clearing the pending hit prevents a later phantom flight',
  );
  memory.job = 'sticks';
  const afterPrematureStop = decide(reading({ events: fall.slice(1), last: { id: 'g1', kind: 'gather', ok: false, reason: 'brain: hurt' } }), memory);
  assert.notEqual(afterPrematureStop.start, 'travel', 'a delayed gravity message also cancels the carried flight');
  const mistakenFlight = fresh();
  mistakenFlight.job = 'hide';
  mistakenFlight.scares.push({ x: 0, z: 0, at: 1 });
  assert.deepEqual(
    decide(reading({ events: fall.slice(1), active: { id: 'f1', kind: 'travel', state: 'running', by: 'brain' } }), mistakenFlight),
    { stop: 'fall' },
    'a gravity message one tick late ends a flight already launched by the raw hurt event',
  );
});

test('brain: poison from emergency food is not mistaken for an unseen attacker', () => {
  const poison = [
    { id: 1, at: 1, type: 'hurt', health: 10 },
    { id: 2, at: 2, type: 'message', text: 'Lost 1 hp through poison', kind: 'Notification' },
  ];
  const memory = fresh();
  memory.job = 'eat';
  const running = { id: 'f1', kind: 'forage', state: 'running', by: 'brain' };
  assert.deepEqual(decide(reading({ events: poison, active: running }), memory), { wait: 'letting forage finish' });
});

test('brain: full-health drift is not mistaken for damage', () => {
  const memory = fresh();
  memory.job = 'sticks';
  const running = { id: 'g1', kind: 'gather', state: 'running', by: 'brain' };
  const full = state({ vitals: { health: { current: 20.57154, max: 20.57154 }, hunger: { current: 600, max: 1500 } } });
  assert.deepEqual(decide(reading({ state: full, events: [{ id: 1, at: 1, type: 'hurt', health: 20.57154 }], active: running }), memory), {
    wait: 'letting gather finish',
  });
  assert.equal(memory.pendingHurtAt, null);
});

test('brain: damage from a nearby threat proves a burrow is unsafe', () => {
  const memory = fresh();
  memory.burrow = { x: 0, y: 102, z: 0 };
  const attacked = state({
    nearbyEntities: [{ code: 'game:drifter-normal', point: { x: 1, y: 100, z: 0 }, distance: 1, how: 'near', at: 1 }],
    vitals: { health: { current: 17.5, max: 20 }, hunger: { current: 750, max: 1500 } },
  });
  const next = decide(reading({ environment: night, state: attacked, events: [{ id: 1, at: 1, type: 'hurt', health: 17.5 }] }), memory);
  assert.equal(next.start, 'dig_area', 'actual damage opens the completed burrow before attempting to flee');
  assert.deepEqual(next.args.cells, [memory.burrow]);
  assert.equal(next.why, 'burrow breached, opening escape');

  memory.job = 'unburrow';
  const opening = { id: 'mouth', kind: 'dig_area', state: 'running', by: 'brain' };
  assert.deepEqual(
    decide(reading({ environment: night, state: attacked, active: opening }), memory),
    { wait: 'letting dig_area finish' },
    'the nearby attacker cannot cancel the only route out',
  );
});

test('brain: kit reads tools by class and dirt by code', () => {
  const k = kit(
    inventory(slot('game:knife-generic-flint', 1, { tool: 'Knife', durability: 5 }), slot('game:soil-medium-none', 12), slot('game:flint', 3)),
  );
  assert.deepEqual([k.knife, k.axe, k.dirt, k.stone, k.dirtCode], [true, false, 12, true, 'game:soil-medium-none']);
  assert.equal(brain.name, 'default');
});

test('brain loop: respawns when dead, waits behind an operator goal, starts and remembers its own goal', async () => {
  const calls = [];
  let dead = true;
  const controller = {
    active: null,
    last: null,
    brain: null,
    history: new Map(),
    send: async request => {
      calls.push(request);
      if (request.action === 'observe') return dead ? { ok: true, alive: false, life: { deathId: 'd:1', canRespawn: true } } : state();
      if (request.action === 'respawn') {
        dead = false;
        return { ok: true };
      }
      return request.action === 'inventory' ? inventory() : { ok: true, ...day };
    },
    request: async (request, options) => {
      calls.push({ ...request, by: options?.by });
      if (request.action === 'respawn') {
        dead = false;
        return { ok: true };
      }
      controller.active = { id: 'b1', kind: request.action, state: 'running', by: 'brain' };
      return { ok: true, goal: { id: 'b1' } };
    },
    stop: async () => {
      controller.active = null;
    },
    goalView: () => null,
  };
  const loop = new BrainLoop(controller as any, brain, 5);
  loop.start();
  await new Promise(resolve => setTimeout(resolve, 30));
  const goal = loop.goal;
  controller.active = { id: 'o1', kind: 'travel', state: 'running', by: 'operator' };
  await new Promise(resolve => setTimeout(resolve, 20));
  const decision = loop.lastDecision;
  // Stop before asserting so a failure never leaves the loop ticking.
  await loop.stop();
  assert.ok(calls.some(c => c.action === 'respawn' && c.deathId === 'd:1'));
  assert.ok(
    calls.some(c => c.action === 'gather' && c.by === 'brain'),
    'starts the first kit job (a stick for the knife)',
  );
  assert.deepEqual(goal, { id: 'b1', kind: 'gather' });
  assert.match(decision, /letting travel finish \(operator\)/);
  assert.equal(controller.active.by, 'operator', 'an operator goal is never cancelled by the brain');
});

test('brain loop: a swimming bot with no goal swims for the nearest dry ground, jump held', async () => {
  const calls: any[] = [];
  const dry = { x: 3.5, y: 100, z: 0.5 };
  const controller = {
    active: null,
    last: null,
    brain: null,
    history: new Map(),
    wants: [],
    map: { nodeAt: (x, z) => (x === 3 && z === 0 ? dry : null) },
    send: async request => {
      calls.push(request);
      return request.action === 'observe'
        ? state({
            position: { x: 0.5, y: 99, z: 0.5 },
            motion: { swimming: true, feetInLiquid: true },
            orientation: { yawDegrees: 180 },
            vitals: { hunger: { current: 500, max: 1500 }, oxygen: { current: 10000, max: 40000 } },
          })
        : request.action === 'inventory'
          ? inventory()
          : { ok: true, ...day };
    },
    request: async request => {
      calls.push(request);
      if (!['look', 'move'].includes(request.action)) throw new Error('no goal should start while swimming');
      return { ok: true };
    },
    stop: async () => {},
    goalView: () => null,
  };
  const loop = new BrainLoop(controller as any, brain, 5);
  loop.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  await loop.stop();
  const look = calls.find(c => c.action === 'look'),
    move = calls.find(c => c.action === 'move');
  assert.equal(Math.round(look.yawDegrees), 90, 'faces the dry cell to the east');
  assert.deepEqual([move.jump, move.sneak, move.direction], [true, false, 'forward']);
});

test('brain loop: a wading bot with no goal moves toward dry ground before starting work', async () => {
  const calls: any[] = [];
  const dry = { x: 3.5, y: 100, z: 0.5 };
  const controller = {
    active: null,
    last: null,
    brain: null,
    history: new Map(),
    wants: [],
    map: { nodeAt: (x, z) => (x === 3 && z === 0 ? dry : null) },
    send: async request => {
      calls.push(request);
      return request.action === 'observe'
        ? state({
            position: { x: 0.5, y: 100, z: 0.5 },
            motion: { onGround: true, swimming: false, feetInLiquid: true },
            orientation: { yawDegrees: 180 },
            vitals: { hunger: { current: 500, max: 1500 }, oxygen: { current: 40000, max: 40000 } },
          })
        : request.action === 'inventory'
          ? inventory()
          : { ok: true, ...night };
    },
    request: async request => {
      calls.push(request);
      if (!['look', 'move'].includes(request.action)) throw new Error('no goal should start with wet footing');
      return { ok: true };
    },
    stop: async () => {},
    goalView: () => null,
  };
  const loop = new BrainLoop(controller as any, brain, 5);
  loop.start();
  await new Promise(resolve => setTimeout(resolve, 25));
  await loop.stop();
  const look = calls.find(c => c.action === 'look'),
    move = calls.find(c => c.action === 'move');
  assert.equal(Math.round(look.yawDegrees), 90, 'faces the dry cell to the east');
  assert.deepEqual([move.jump, move.sneak, move.direction], [true, false, 'forward']);
  assert.match(loop.lastDecision, /wading toward 4,1/);
});

test('brain loop: an act decision runs its actions in order by hand', async () => {
  const calls: any[] = [];
  const controller = {
    active: null,
    last: null,
    brain: null,
    history: new Map(),
    wants: [],
    send: async request => (request.action === 'observe' ? state() : request.action === 'inventory' ? inventory() : { ok: true, ...day }),
    request: async (request, options) => {
      calls.push({ ...request, by: options?.by });
      return { ok: true };
    },
    stop: async () => {},
    goalView: () => null,
  };
  const reflex = {
    name: 'reflex',
    description: '',
    fresh: () => ({}),
    decide: () => ({
      act: [
        { action: 'look', yawDegrees: 90, pitchDegrees: 0 },
        { action: 'move', durationMs: 500, direction: 'forward' },
      ],
      why: 'test',
    }),
  };
  const loop = new BrainLoop(controller as any, reflex as any, 5);
  loop.start();
  await new Promise(resolve => setTimeout(resolve, 20));
  await loop.stop();
  assert.deepEqual(
    calls.slice(0, 2).map(c => c.action),
    ['look', 'move'],
  );
  assert.equal(calls[0].by, 'brain');
});

test('brain: hunger does not interrupt a flight; danger outranks it', () => {
  const memory = fresh();
  const wolf = state({
    nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }],
    vitals: { hunger: { current: 100, max: 1500 } },
  });
  assert.equal(decide(reading({ state: wolf }), memory).start, 'travel');
  const during = decide(reading({ state: wolf, active: { id: 'f1', kind: 'travel', state: 'running', by: 'brain' } }), memory);
  assert.equal(during.wait, 'letting travel finish');
  const stormy = state({ ...wolf, condition: { temporalStorm: { phase: 'active' } } });
  assert.equal(
    decide(reading({ state: stormy, active: { id: 'f1', kind: 'travel', state: 'running', by: 'brain' } }), memory).wait,
    'letting travel finish',
    'nor does a storm',
  );
});

test('brain: forage keeps its own threat evasion instead of being cancelled', () => {
  const memory = fresh();
  memory.job = 'eat';
  const wolf = state({
    nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }],
    vitals: { hunger: { current: 100, max: 1500 } },
  });
  assert.deepEqual(decide(reading({ state: wolf, active: { id: 'food', kind: 'forage', state: 'running', by: 'brain' } }), memory), {
    wait: 'letting forage evade threat',
  });
  const food = { id: 'food', kind: 'forage', state: 'running', by: 'brain' };
  assert.deepEqual(
    decide(
      reading({
        state: state({ vitals: { hunger: { current: 100, max: 1500 } } }),
        active: food,
        events: [{ id: 1, at: 1, type: 'hurt', health: 10 }],
        now: 1000,
      }),
      memory,
    ),
    { wait: 'identifying damage source' },
  );
  assert.deepEqual(
    decide(reading({ state: state({ vitals: { hunger: { current: 100, max: 1500 } } }), active: food, now: 1000 + HURT_CLASSIFY_MS + 1 }), memory),
    { stop: 'hurt' },
    'unexplained damage still interrupts food recovery',
  );
});

test('brain: night waits for forage to finish food already in hand', () => {
  const memory = fresh();
  memory.job = 'eat';
  const berries = inventory(
    slot('game:fruit-blackberry', 3, {
      nutrition: { saturation: 80, health: 0 },
      freshness: { state: 'fresh', freshHoursLeft: 100 },
    }),
  );
  assert.deepEqual(
    decide(
      reading({
        environment: night,
        inventory: berries,
        state: state({ vitals: { hunger: { current: 330, max: 1500 } } }),
        active: { id: 'food', kind: 'forage', state: 'running', by: 'brain' },
      }),
      memory,
    ),
    { wait: 'letting forage finish' },
  );
  assert.deepEqual(
    decide(
      reading({
        environment: night,
        state: state({ vitals: { hunger: { current: 430, max: 1500 } } }),
        active: { id: 'food', kind: 'forage', state: 'running', by: 'brain' },
      }),
      memory,
    ),
    { wait: 'letting forage finish' },
    'crossing the urgent threshold on the last carried bite does not cancel the recovery run',
  );
});

test('brain: carried food enters one complete recovery run', () => {
  const memory = fresh();
  const berries = inventory(
    slot('game:fruit-blackberry', 3, {
      nutrition: { saturation: 80, health: 0 },
      freshness: { state: 'fresh', freshHoursLeft: 100 },
    }),
  );
  const choice = decide(
    reading({
      inventory: berries,
      state: state({ vitals: { hunger: { current: 100, max: 1500 } } }),
    }),
    memory,
  );
  assert.equal(choice.start, 'forage');
  assert.ok(Math.abs(choice.args.until - 0.5) < 1e-9);
  assert.equal(choice.args.keep, 160);
  assert.match(choice.why, /240 carried/);
});

test('brain: digging out of a hole is never interrupted by a threat', () => {
  const digging = fresh();
  digging.job = 'dig_out';
  const wolf = state({
    nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }],
  });
  const during = decide(reading({ state: wolf, active: { id: 'd1', kind: 'dig_out', state: 'running', by: 'brain' } }), digging);
  assert.equal(during.wait, 'letting dig_out finish');
});

test('brain: a partial pit escape resumes instead of starting work underground', () => {
  const memory = fresh();
  memory.pit = { x: 8.5, y: 100, z: 0.5 };
  memory.job = 'dig_out';
  const next = decide(
    reading({
      last: { id: 'd1', kind: 'dig_out', ok: false, reason: 'no_footing', result: { ok: false, climbed: 1, reason: 'no_footing' } },
    }),
    memory,
  );
  assert.equal(next.start, 'dig_out');
  assert.deepEqual([next.args.x, next.args.z], [8.5, 0.5]);

  memory.job = 'dig_out';
  const escaped = decide(reading({ last: { id: 'd2', kind: 'dig_out', ok: true, result: { ok: true, climbed: 1 } } }), memory);
  assert.notEqual(escaped.start, 'dig_out');
  assert.equal(memory.pit, null);
});

test('brain: observed height preserves a partial pit escape when an action error omits its result', () => {
  const memory = fresh();
  memory.pit = { x: 8.5, y: 100, z: 0.5 };
  memory.job = 'dig_out';
  const next = decide(
    reading({
      state: state({ position: { x: 1.5, y: 102, z: 0.5 } }),
      last: { id: 'd1', kind: 'dig_out', ok: false, reason: 'Target or inventory changed; inspect before acting.' },
    }),
    memory,
  );
  assert.equal(next.start, 'dig_out');
  assert.deepEqual([next.args.x, next.args.z], [8.5, 0.5]);
});

test('brain: opening a morning burrow is followed by digging steps to the surface', () => {
  const memory = fresh();
  memory.burrow = { x: 0, y: 2, z: 0 };
  memory.job = 'unburrow';
  const outside = decide(
    reading({
      state: state({ position: { x: 0.5, y: 0, z: 0.5 } }),
      last: { id: 'mouth', kind: 'dig_area', ok: true, result: { dug: 1 } },
    }),
    memory,
  );
  assert.equal(memory.burrow, null);
  assert.equal(outside.start, 'dig_out');
  assert.deepEqual([outside.args.x, outside.args.z], [8.5, 0.5]);
});

test('brain: hunger, not morning, explains opening a burrow at night', () => {
  const memory = fresh();
  memory.burrow = { x: 0, y: 102, z: 0 };
  const next = decide(
    reading({
      environment: night,
      state: state({ vitals: { hunger: { current: 299, max: 1500 } } }),
    }),
    memory,
  );
  assert.equal(next.start, 'dig_area');
  assert.equal(next.why, 'hungry, opening the burrow');
});

test('brain: a fresh controller recovers a sealed burrow from observed terrain', () => {
  const full = { hazard: null, boxes: [[0, 0, 0, 1, 1, 1]] };
  let ready = false,
    sealed = true;
  const terrain = {
    get(x, y, z) {
      if (!ready) return null;
      if (y === 102 && (x !== 0 || z !== 0)) return full;
      if (x === 0 && y === 102 && z === 0) return sealed ? full : { hazard: null, boxes: [] };
      return { hazard: null, boxes: [] };
    },
  };
  const memory = fresh();
  assert.deepEqual(decide(reading({ state: state({ position: { x: 0.5, y: 100, z: 0.5 } }), terrain }), memory), {
    wait: 'inspecting surroundings after startup',
  });
  assert.equal(memory.startupChecked, false, 'an empty first terrain delta cannot trigger a second burrow');
  ready = true;
  const next = decide(reading({ state: state({ position: { x: 0.5, y: 100, z: 0.5 } }), terrain }), memory);
  assert.deepEqual(memory.burrow, { x: 0, y: 102, z: 0 });
  assert.equal(next.start, 'dig_area');
  assert.deepEqual(next.args.cells, [memory.burrow]);

  sealed = false;
  const openAtNight = fresh();
  const sheltered = decide(reading({ environment: night, state: state({ position: { x: 0.5, y: 100, z: 0.5 } }), terrain }), openAtNight);
  assert.deepEqual(openAtNight.burrow, { x: 0, y: 102, z: 0 });
  assert.equal(sheltered.wait, 'night, dug in', 'an intentionally unsealed emergency shaft remains shelter at night');

  const openByDay = fresh();
  const climbing = decide(reading({ state: state({ position: { x: 0.5, y: 100, z: 0.5 } }), terrain }), openByDay);
  assert.equal(openByDay.burrow, null);
  assert.equal(climbing.start, 'dig_out');

  const shallowTerrain = {
    get(x, y, z) {
      if (y === 101 && (x !== 0 || z !== 0)) return full;
      return { hazard: null, boxes: [] };
    },
  };
  const shallowAtNight = fresh();
  const shallowSheltered = decide(
    reading({ environment: night, state: state({ position: { x: 0.5, y: 100, z: 0.5 } }), terrain: shallowTerrain }),
    shallowAtNight,
  );
  assert.deepEqual(shallowAtNight.burrow, { x: 0, y: 102, z: 0 });
  assert.equal(shallowSheltered.wait, 'night, dug in', 'a surface shaft with its rim one block above is not dug deeper after restart');

  memory.burrow = null;
  decide(reading({ state: state({ position: { x: 20.5, y: 100, z: 20.5 } }), terrain, now: 2000 }), memory);
  assert.equal(memory.burrow, null, 'similar terrain encountered later cannot invent a burrow');

  const wet = fresh();
  decide(reading({ state: state({ position: { x: 0.5, y: 100, z: 0.5 }, motion: { feetInLiquid: true } }), terrain }), wet);
  assert.equal(wet.burrow, null, 'shallow water terrain is not a burrow');
});

test('brain: three scares around the same spot make it move on; a failed stick search is set aside around here', () => {
  const memory = fresh();
  const wolf = state({ nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }] });
  for (let scare = 0; scare < 3; scare++) {
    decide(reading({ state: wolf, now: 1000 + scare }), memory);
    memory.job = null;
  }
  assert.equal(memory.scares.length, 3);
  const calm = decide(reading({ now: 2000 }), memory);
  assert.equal(calm.start, 'travel');
  assert.ok(Math.hypot(calm.args.x, calm.args.z) > 60, 'far from the scares');
  decide(reading({ last: { id: 'r', kind: 'travel', ok: true }, now: 3000 }), memory);
  assert.equal(memory.scares.length, 0);
  const noSticks = fresh();
  noSticks.job = 'sticks';
  const next = decide(
    reading({ inventory: inventory(slot('game:stick', 2)), last: { id: 'g', kind: 'gather', ok: false, reason: 'none_found' }, now: 4000 }),
    noSticks,
  );
  assert.notEqual(noSticks.job, 'sticks', 'sticks are set aside around here; the ladder goes on');
  assert.ok(next.start, 'something else is started instead of idling');
  const elsewhere = { ...state(), position: { x: 40, y: 100, z: 0 } };
  assert.equal(
    decide(reading({ state: elsewhere, inventory: inventory(slot('game:stick', 2)), now: 6000 }), noSticks).start,
    'gather',
    'sticks are looked for again away from where they failed',
  );
});

test('brain: home is a note that outlives the process and is mirrored once on the map', async () => {
  const withMap = state({ capabilities: ['map_waypoint_add'], world: { identifier: 'w1' }, player: { uid: 'p1' } });
  const memory = fresh();
  memory.notes.home = { x: 3, y: 100, z: 5 };
  const marked = decide(reading({ state: withMap }), memory);
  assert.deepEqual(
    marked.act.map(a => a.action),
    ['add_map_waypoint'],
    'a home with no marker gets one',
  );
  assert.equal(marked.act[0].title, 'Home');
  assert.ok(decide(reading({ state: withMap }), memory).start, 'and only once');
  const moved = fresh();
  moved.notes.home = { x: 40, y: 100, z: 5 };
  const marker = { guid: 'g1', title: 'Home', icon: 'home', position: { x: 3, y: 100, z: 5 } };
  assert.deepEqual(
    decide(reading({ state: withMap, markers: [marker] }), moved).act.map(a => a.action),
    ['remove_map_waypoint', 'add_map_waypoint'],
    'a home that moved takes its marker along',
  );
  const found = fresh();
  found.notes.home = { x: 3, y: 100, z: 5 };
  assert.ok(decide(reading({ state: withMap, markers: [marker] }), found).start, 'a marker already there is left alone');
  assert.deepEqual(fresh({ home: { x: 1, y: 2, z: 3 } }).notes.home, { x: 1, y: 2, z: 3 });
  assert.equal(fresh({ home: { x: 'no' } } as any).notes.home, null, 'a damaged note is not a home');

  // Through the loop: a second loop on the same world reads the first one's notes.
  const dir = mkdtempSync(join(tmpdir(), 'seraph-notes-'));
  const controller = {
    active: null,
    last: null,
    brain: null,
    history: new Map(),
    knowledge: { dir },
    send: async request => (request.action === 'observe' ? withMap : request.action === 'inventory' ? inventory() : { ok: true, ...day }),
    request: async request => {
      controller.active = { id: 'b1', kind: request.action, state: 'running', by: 'brain' };
      return { ok: true, goal: { id: 'b1' } };
    },
    stop: async () => {
      controller.active = null;
    },
    goalView: () => null,
  };
  try {
    const first = new BrainLoop(controller as any, brain, 5);
    first.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    (first.memory as any).notes.home = { x: 7, y: 100, z: 9 };
    await first.stop();
    const file = first.notes.status().file;
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')).notes, { home: { x: 7, y: 100, z: 9 }, stash: null });
    const second = new BrainLoop(controller as any, brain, 5);
    second.start();
    await new Promise(resolve => setTimeout(resolve, 30));
    await second.stop();
    assert.deepEqual((second.memory as any).notes.home, { x: 7, y: 100, z: 9 }, 'the next run starts from the note');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('brain: a basket by the door is made in three steps, a full pack is put away, and the basket feeds the kit', () => {
  const tools = [
    slot('game:knife-generic-flint', 1, { tool: 'Knife', durability: 5 }),
    slot('game:axe-flint', 1, { tool: 'Axe', durability: 5 }),
    slot('game:shovel-flint', 1, { tool: 'Shovel', durability: 5 }),
  ];
  const home = { x: 3.5, y: 100, z: 0.5 };
  const settled = () => {
    const memory = fresh();
    memory.notes.home = home;
    return memory;
  };
  const cut = decide(reading({ inventory: inventory(slot('game:stick', 10), ...tools) }), settled());
  assert.deepEqual([cut.start, cut.args.match, cut.args.tool], ['harvest', 'coopersreed', 'Knife'], 'no basket: cut cattail tops first');
  const weave = decide(reading({ inventory: inventory(slot('game:stick', 10), slot('game:cattailtops', 24), ...tools) }), settled());
  assert.deepEqual([weave.start, weave.args.output], ['craft_item', 'game:stationarybasket-east']);
  const carrying = settled();
  const put = decide(reading({ inventory: inventory(slot('game:stick', 10), slot('game:stationarybasket-east', 1), ...tools) }), carrying);
  assert.deepEqual([put.start, put.args.cells[0]], ['build', { x: 4, y: 100, z: 2, item: 'game:stationarybasket-east' }], 'beside the door');
  const built = [{ x: 4, y: 100, z: 2, face: 'up', code: 'game:stationarybasket-north' }];
  decide(
    reading({ inventory: inventory(slot('game:stick', 10), ...tools), last: { id: 'b', kind: 'build', ok: true, result: { built } } }),
    carrying,
  );
  const key = 'block:0:4:100:2:game:stationarybasket-north';
  assert.equal(carrying.notes.stash?.key, key, 'the basket is noted by the key the client observed');

  const heavy = inventory(
    slot('game:stick', 20),
    slot('game:log-placed-oak-ud', 12),
    slot('game:seeds-flax', 3),
    slot('game:torch-basic-extinct-up', 2),
    ...tools,
  );
  const away = decide(reading({ inventory: heavy }), carrying);
  assert.equal(away.start, 'store_items', 'a full pack is put away');
  assert.deepEqual([away.args.target, away.args.items[0]], [key, { item: 'game:stick', count: 10 }], 'ten sticks stay on hand; the rest go first');
  assert.ok(!away.args.items.some(i => /torch|knife/.test(i.item)), 'tools and torches stay');
  decide(
    reading({ inventory: heavy, last: { id: 's', kind: 'store_items', ok: true, result: { contents: [{ code: 'game:stick', quantity: 10 }] } } }),
    carrying,
  );
  assert.deepEqual(carrying.notes.stash?.seen?.items, { 'game:stick': 10 }, 'what the basket held when closed is remembered');
  const roomy = inventory(slot('game:stick', 20), slot('game:log-placed-oak-ud', 12), ...tools, slot(null, 0), slot(null, 0));
  assert.notEqual(decide(reading({ inventory: roomy }), carrying).start, 'store_items', 'with room to spare nothing is put away');

  const short = decide(reading({ inventory: inventory(slot('game:stick', 2), ...tools) }), carrying);
  assert.deepEqual([short.start, short.args.items], ['take_items', [{ item: 'game:stick', count: 8 }]], 'the basket feeds the kit before gathering');
  const gone = { id: 't', kind: 'take_items', ok: false, reason: 'Target not in native reach, changed or obstructed; no action sent' };
  decide(reading({ inventory: inventory(slot('game:stick', 2), ...tools), last: gone }), carrying);
  assert.equal(carrying.notes.stash, null, 'a basket that cannot be opened again is forgotten');
  assert.deepEqual(fresh({ stash: { key, x: 4, y: 100, z: 2, code: 'game:stationarybasket-north', seen: null } }).notes.stash?.key, key);
  assert.equal(fresh({ stash: { key } } as any).notes.stash, null, 'a damaged note is not a basket');
});
