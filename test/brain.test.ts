import assert from 'node:assert/strict';
import { test } from 'node:test';
import brain, { decide as decision, fresh, kit, pickJob, SHELTER_DIRT, STICK_MIN, shelterCells } from '../src/brain/default.ts';

const decide = (reading, memory): any => decision(reading, memory);

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
  _night = { calendar: { daylight: 0.1 } };
const reading = (extra = {}) => ({ state: state(), inventory: inventory(), environment: day, active: null, last: null, now: 1000, ...extra });
const situation = (extra = {}) => ({
  burrowed: false,
  threat: false,
  storm: false,
  hunger: 0.8,
  night: false,
  home: true,
  atHome: true,
  sticks: 10,
  knife: true,
  axe: true,
  stone: false,
  torches: 2,
  grass: 0,
  dirt: 0,
  logs: 8,
  ...extra,
});

test('brain: danger, hunger and night come before the kit, and the kit comes in day-1 order', () => {
  assert.equal(pickJob(situation({ threat: true, hunger: 0.1 })), 'hide');
  assert.equal(pickJob(situation({ storm: true, atHome: false })), 'go_home');
  assert.equal(pickJob(situation({ hunger: 0.1, night: true })), 'eat');
  assert.equal(pickJob(situation({ night: true, atHome: false })), 'go_home');
  assert.equal(pickJob(situation({ night: true, home: false, dirt: 0 })), 'burrow');
  assert.equal(pickJob(situation({ night: true, home: false, burrowed: true })), 'wait');
  assert.equal(pickJob(situation({ home: false, burrowed: true })), 'unburrow');
  assert.equal(pickJob(situation({ home: false, dirt: SHELTER_DIRT })), 'shelter');
  assert.equal(pickJob(situation({ home: false })), 'dirt');
  assert.equal(pickJob(situation({ sticks: 3 })), 'sticks');
  assert.equal(pickJob(situation({ knife: false })), 'stone');
  assert.equal(pickJob(situation({ knife: false, stone: true })), 'tools');
  assert.equal(pickJob(situation({ torches: 0 })), 'grass');
  assert.equal(pickJob(situation({ torches: 0, grass: 2 })), 'torches');
  assert.equal(pickJob(situation({ logs: 1 })), 'logs');
  assert.equal(pickJob(situation()), 'explore');
});

test('brain: a threat interrupts its own goal, a failed job cools down, a finished shelter becomes home', () => {
  const memory = fresh();
  memory.home = { x: 0, y: 100, z: 0 };
  const first = decide(reading({ inventory: inventory(slot('game:stick', 2)) }), memory);
  assert.deepEqual([first.start, first.args.count, memory.job], ['gather_sticks', STICK_MIN - 2, 'sticks']);
  const wolf = state({ nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }] });
  assert.deepEqual(decide(reading({ state: wolf, active: { id: 'g1', kind: 'gather_sticks', state: 'running', by: 'brain' } }), memory), {
    stop: 'threat',
  });
  const failed = decide(
    reading({ inventory: inventory(slot('game:stick', 2)), last: { id: 'g1', kind: 'gather_sticks', ok: false, reason: 'blocked' }, now: 2000 }),
    memory,
  );
  assert.equal(failed.wait, 'sticks cooling down');
  const fled = decide(reading({ state: wolf }), memory);
  assert.equal(fled.start, 'travel');
  const again = decide(reading({ state: wolf, last: { id: 'g2', kind: 'travel', ok: false, reason: 'interrupted' }, now: 3000 }), memory);
  assert.equal(again.start, 'travel', 'a failed flight is tried again at once');
  const shelterMemory = fresh();
  const dirt = inventory(slot('game:soil-medium-none', SHELTER_DIRT));
  const walls = decide(reading({ inventory: dirt }), shelterMemory);
  assert.equal(walls.start, 'build');
  assert.equal(shelterMemory.shelter.phase, 'walls');
  assert.equal(shelterCells({ x: 0, y: 0, z: 0 }, 'd').length, 23);
  for (let phase = 0; phase < 8 && shelterMemory.shelter; phase++)
    decide(reading({ inventory: dirt, last: { id: `s${phase}`, kind: 'build', ok: true } }), shelterMemory);
  assert.ok(shelterMemory.home);
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
      if (request.action === 'observe') return dead ? { ok: true, alive: false, life: { deathId: 'd:1' } } : state();
      if (request.action === 'respawn') {
        dead = false;
        return { ok: true };
      }
      return request.action === 'inventory' ? inventory() : { ok: true, ...day };
    },
    request: async (request, options) => {
      calls.push({ ...request, by: options?.by });
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
  assert.ok(calls.some(c => c.action === 'respawn' && c.deathId === 'd:1'));
  assert.ok(
    calls.some(c => c.action === 'harvest' && c.by === 'brain'),
    'starts the first kit job (dirt for a shelter)',
  );
  assert.deepEqual(loop.goal, { id: 'b1', kind: 'harvest' });
  controller.active = { id: 'o1', kind: 'travel', state: 'running', by: 'operator' };
  await new Promise(resolve => setTimeout(resolve, 20));
  assert.match(loop.lastDecision, /waiting for travel/);
  await loop.stop();
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
        : { ok: true };
    },
    request: async () => {
      throw new Error('no goal should start while swimming');
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

test('brain: digging out of a hole is never interrupted by a threat', () => {
  const digging = fresh();
  digging.job = 'dig_out';
  const wolf = state({
    nearbyEntities: [{ code: 'game:wolf-male', point: { x: 5, y: 100, z: 0 }, distance: 5, how: 'seen', at: 1 }],
  });
  const during = decide(reading({ state: wolf, active: { id: 'd1', kind: 'dig_out', state: 'running', by: 'brain' } }), digging);
  assert.equal(during.wait, 'letting dig_out finish');
});
