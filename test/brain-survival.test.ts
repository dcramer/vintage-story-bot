import assert from 'node:assert/strict';
import { test } from 'node:test';
import { goTo } from '../src/brain/default/concern.ts';
import { recoverBurrow } from '../src/brain/default/reflexes/burrow.ts';
import { goHome } from '../src/brain/default/reflexes/go_home.ts';
import { makeBag } from '../src/brain/default/tasks/bags.ts';
import { house, houseSite } from '../src/brain/default/tasks/house.ts';
import { lightingDay, shelterLight } from '../src/brain/default/tasks/lighting.ts';
import { recover, recoverableBody } from '../src/brain/default/tasks/recover.ts';
import { homeDamage, repairHome } from '../src/brain/default/tasks/repair_home.ts';
import { shelter } from '../src/brain/default/tasks/shelter.ts';
import { surplusOf } from '../src/brain/default/tasks/stash.ts';
import { SUPPLIES, stockpile } from '../src/brain/default/tasks/stockpile.ts';
import { fresh, kit } from '../src/brain/default.ts';
import { selectedPlacementCell, selectedPlacementSupport, stablePlacementSupport, standNear } from '../src/goals/build.ts';
import craft from '../src/goals/craft_item.ts';
import buildHouse from '../src/goals/house.ts';
import { shelterSite } from '../src/goals/shelter.ts';
import { findRoute } from '../src/runtime/navigation/planner.ts';
import { TerrainMemory } from '../src/runtime/navigation/terrain.ts';
import {
  houseScaffold,
  house as houseTemplate,
  shelterDoor,
  shelterScaffold,
  shelterStorage,
  shelterTorches,
  shelter as template,
} from '../src/support/structures.ts';

test('starter template stays enclosed with reachable interior torch positions', () => {
  const origin = { x: 0, y: 100, z: 0 };
  const walls = [...template(origin, 'game:rammed-light-plain'), ...shelterDoor(origin, 'game:rammed-light-plain')];
  const keys = new Set(walls.map(c => `${c.x},${c.y},${c.z}`));
  assert.equal(keys.size, 57);
  assert.ok(
    walls.every(c => c.y >= origin.y),
    'all construction is above the natural floor',
  );
  assert.deepEqual(shelterTorches(origin), [{ x: 2, y: 100, z: 1 }]);
  assert.deepEqual(shelterScaffold(origin, 'earth'), [
    { x: 1, y: 100, z: 6, item: 'earth' },
    { x: 1, y: 100, z: 5, item: 'earth' },
    { x: 1, y: 101, z: 5, item: 'earth' },
  ]);
  assert.equal(houseScaffold(origin, 'earth').length, 3);
  const storage = shelterStorage(origin);
  assert.equal(storage.length, 6);
  for (const cell of storage) {
    assert.ok(cell.x === 1 || cell.x === 3, 'chests leave the center aisle clear');
    assert.ok(!keys.has(`${cell.x},${cell.y},${cell.z}`), 'chest slots are inside the shell');
  }
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) assert.ok(keys.has(`${x},102,${z}`), 'sealed roof');
  for (const torch of shelterTorches(origin)) assert.ok(!keys.has(`${torch.x},${torch.y},${torch.z}`), 'torch is inside clear space');
});

test('the front staircase still reaches the roof after the walls are covered', () => {
  const origin = { x: 0, y: 100, z: 0 };
  const map = new TerrainMemory();
  for (let x = -2; x <= 6; x++)
    for (let z = -2; z <= 8; z++)
      for (let y = 99; y <= 106; y++) map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [] });
  for (const { x, y, z } of [...template(origin, 'earth'), ...shelterScaffold(origin, 'earth')])
    map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: [[x, y, z, x + 1, y + 1, z + 1]] });
  const start = { x: 1.5, y: 100, z: 7.5 },
    goal = { x: 2.5, y: 103, z: 2.5 };
  assert.ok(findRoute(map, start, goal, 0.3, 1.85, { partial: false }), 'every rise onto the completed roof is a legal jump');
  for (const { x, y, z } of [shelterScaffold(origin, 'earth')[0], shelterScaffold(origin, 'earth')[2]])
    map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: [] });
  assert.equal(findRoute(map, start, goal, 0.3, 1.85, { partial: false }), null, 'one front block cannot reach a roof-covered wall');
});

test('a roof placement retry chooses a higher viewpoint instead of another spot beneath it', async () => {
  const state = { position: { x: 2.5, y: 100, z: 2.5 }, body: { eyeHeight: 1.7 } };
  const beneath = { x: 3.5, y: 100, z: 2.5 };
  const rooftop = { x: 3.5, y: 103, z: 2.5 };
  let destination;
  const field = {
    latest: state,
    observe: async () => state,
    look: async () => {},
    approach: (_object, exclude) => [beneath, rooftop].find(q => !exclude(q)),
    walk: async q => {
      destination = q;
      return { state: 'arrived' };
    },
  };
  assert.equal(await standNear(field, null, { x: 4, y: 102, z: 2 }, true, true), true);
  assert.deepEqual(destination, rooftop);
  assert.equal(await standNear(field, null, { x: 4, y: 102, z: 2 }, true, false), true);
  assert.deepEqual(destination, beneath, 'digging an overhead block may still use its underside');
});

test('building never uses replaceable snow as a support face', () => {
  const solid = { code: 'game:soil-low-none', boxes: [[0, 0, 0, 1, 1, 1]], hazard: null, traits: [] };
  const snow = { code: 'game:snowlayer-3', boxes: [[0, 0, 0, 1, 0.375, 1]], hazard: null, traits: [] };
  assert.equal(stablePlacementSupport(solid), true);
  assert.equal(stablePlacementSupport(snow), false, 'code-derived traits cover terrain memories without semantic traits');
  assert.equal(
    selectedPlacementSupport(snow, { code: 'game:rammed-light-plain' }),
    true,
    'the block selected in the live client supersedes stale snow memory',
  );
  assert.equal(
    selectedPlacementSupport(solid, { code: 'game:snowlayer-3' }),
    false,
    'live replaceable cover is never accepted merely because memory was solid',
  );
  assert.equal(selectedPlacementCell('game:rammed-light-plain', { code: 'game:rammed-light-plain' }), 'placed');
  assert.equal(selectedPlacementCell('game:rammed-light-plain', { code: 'game:snowlayer-3' }), 'clear');
  assert.equal(selectedPlacementCell('game:rammed-light-plain', { code: 'game:soil-low-none' }), 'blocked');
});

test('the larger house retains a legal route from the ground to its completed ridge', () => {
  const origin = { x: 0, y: 100, z: 0 };
  const map = new TerrainMemory();
  for (let x = -2; x <= 11; x++)
    for (let z = -2; z <= 10; z++)
      for (let y = 99; y <= 107; y++) map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [] });
  for (const { x, y, z } of [...houseTemplate(origin, 'earth'), ...houseScaffold(origin, 'earth')])
    map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: [[x, y, z, x + 1, y + 1, z + 1]] });
  const start = { x: 3.5, y: 100, z: 9.5 },
    goal = { x: 4.5, y: 105, z: 3.5 };
  assert.ok(findRoute(map, start, goal, 0.3, 1.85, { partial: false }));
  for (const { x, y, z } of [houseScaffold(origin, 'earth')[0], houseScaffold(origin, 'earth')[2]])
    map.put({ x, y, z, seenAt: Date.now(), traits: [], boxes: [] });
  assert.equal(findRoute(map, start, goal, 0.3, 1.85, { partial: false }), null, 'one step leaves the finished eaves two blocks above the player');
});

test('torch refresh begins at 05:00 and an observed missing torch invalidates the same-day check', () => {
  const environment = hour => ({ calendar: { totalDays: 100 + hour / 24 } });
  assert.equal(lightingDay(environment(0)), lightingDay({ calendar: { totalDays: 99 + 23 / 24 } }));
  const notes = { home: { x: 2.5, y: 100, z: 2.5 }, starter: { x: 0, y: 100, z: 0 }, lightingDay: 99 };
  const terrain = { get: () => ({ code: 'game:torch-basic-lit-up' }) };
  assert.equal(shelterLight({ terrain, environment: environment(4.99) }, notes).lit, true);
  assert.equal(shelterLight({ terrain, environment: environment(5) }, notes).lit, false);
  notes.lightingDay = 100;
  assert.equal(shelterLight({ terrain, environment: environment(5) }, notes).lit, true);
  assert.equal(shelterLight({ terrain: { get: () => ({ code: 'game:air' }) }, environment: environment(5) }, notes).lit, false);
});

const inventory = (items: Record<string, number>) => ({
  inventories: [{ name: 'hotbar', slots: Object.entries(items).map(([code, quantity], slot) => ({ code, quantity, slot })) }],
});
const chest = {
  key: 'block:0:0:100:0:game:stationarybasket-east',
  x: 0,
  y: 100,
  z: 0,
  code: 'game:stationarybasket-east',
  seen: { at: 1000, items: {} },
};

test('ordinary errands and body recovery do not turn into food searches', () => {
  const trip: any = goTo({ state: { position: { x: 0, y: 100, z: 0 } } } as any, { x: 100, y: 100, z: 0 }, 'durable work');
  assert.equal(trip.args.manageFood, false);
  const body: any = recover.run({ memory: fresh({ recovery: { guid: 'death-one', until: 601000 } }), now: 1000 } as any);
  assert.equal(body.args.manageFood, false);
});

test('an old death marker cannot renew recovery after a controller restart', () => {
  const marker = { guid: 'death-one', icon: 'gravestone' };
  const memory = fresh();
  assert.equal(recoverableBody([marker], memory.notes, 1000), true);
  const restarted = fresh(memory.notes);
  assert.equal(recoverableBody([marker], restarted.notes, 601000), false);
  assert.equal(recoverableBody([marker, { ...marker, guid: 'death-two' }], restarted.notes, 601000), true);
});

test('knapping requires two matching stones and prefers a usable stack over a lone flint', () => {
  const mixed = kit(inventory({ 'game:flint': 1, 'game:stone-peridotite': 1 }));
  assert.equal(mixed.knappables, 1);
  const usable = kit(inventory({ 'game:flint': 1, 'game:stone-peridotite': 3 }));
  assert.equal(usable.material, 'peridotite');
  assert.equal(usable.knappables, 3);
});

test('house: partial material batches resume the same site without claiming a home', () => {
  const memory = fresh({ construction: { origin: { x: 0, y: 100, z: 0 }, phase: 'walls' } });
  const ctx: any = { memory, k: kit(inventory({ 'game:packeddirt': 6 })), state: { position: { x: 4.5, y: 100, z: 7.5 } } };
  const packed: any = house.run(ctx);
  assert.equal(packed.start, 'craft_item');
  assert.equal(packed.args.count, 6, 'do not request more crafts than the carried batch supports');
  craft.schema.parse(packed.args);
  ctx.k = kit(inventory({ 'game:soil-high-none': 64, 'game:soil-low-none': 5, 'game:soil-medium-none': 5 }));
  const soil: any = house.run(ctx);
  assert.equal(soil.start, 'harvest', 'incompatible stacks cannot be counted as a packed-dirt batch');
  assert.equal(soil.args.item, 'soil-low-none');
  assert.equal(soil.args.count, 23);
  ctx.reading = {
    terrain: { cells: new Map([['forest', { x: 5, z: 7, code: 'game:forestfloor-1' }]]) },
  };
  const forestFloor: any = house.run(ctx);
  assert.equal(forestFloor.args.match, 'forestfloor-', 'observed local forest floor supplies the low soil its handbook says it drops');
  ctx.k = kit(inventory({ 'game:rammed-light-plain': 6 }));
  const walls: any = house.run(ctx);
  assert.equal(walls.start, 'house');
  buildHouse.schema.parse(walls.args);
  const partial: any = { kind: 'house', ok: false, reason: 'out_of_material' };
  house.ended!(partial, memory, {} as any);
  assert.equal(house.setAside!(partial, memory, {} as any), false);
  const site: any = { kind: 'house', ok: false, reason: 'not_selectable', result: { phase: 'site' } };
  assert.equal(house.setAside!(site, memory, {} as any), false, 'incremental site clearing retries the owned house');
  assert.equal(memory.notes.home, null);
  assert.equal(fresh(memory.notes).notes.construction?.phase, 'walls');
  house.ended!({ kind: 'house', ok: true } as any, memory, {} as any);
  assert.equal(memory.notes.construction?.phase, 'floor');
  assert.equal(memory.notes.home, null, 'a roof alone is not a finished home');
});

test('finished construction offloads its surplus and the next house retrieves it before gathering', () => {
  const k = kit(inventory({ 'game:packeddirt': 30, 'game:rammed-light-plain': 18, 'game:soil-low-none': 130 }));
  const surplus = surplusOf(k, { home: true, torches: 1 });
  assert.deepEqual(surplus, [
    { item: 'game:soil-low-none', count: 126 },
    { item: 'game:packeddirt', count: 30 },
    { item: 'game:rammed-light-plain', count: 12 },
  ]);
  assert.ok(!surplusOf(k, { home: true, torches: 1, building: true }).some(s => s.item === 'game:packeddirt'));
  const memory = fresh({
    construction: { origin: { x: 8, y: 100, z: 8 }, phase: 'walls' },
    stash: { ...chest, seen: { at: 0, items: { 'game:packeddirt': 30 } } },
  });
  const next = house.run({ memory, k: kit(inventory({})), state: { position: chest } } as any);
  assert.ok('start' in next && next.start === 'take_items');
  assert.deepEqual(next.args.items, [{ item: 'game:packeddirt', count: 28 }]);
  memory.notes.construction!.origin = { x: 100, y: 100, z: 100 };
  const distant = house.run({ memory, k: kit(inventory({})), state: { position: chest } } as any);
  assert.ok('start' in distant && distant.start === 'harvest', 'distant stored dirt cannot pull construction away from its camp');
});

test('house: unknown terrain and hazards never qualify as a building site', () => {
  const p = { x: 0.5, y: 100, z: 0.5 };
  assert.equal(houseSite({ get: () => undefined }, p), null);
  const terrain = { get: (x: number, y: number, z: number) => ({ boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [], hazard: null }) };
  assert.ok(houseSite(terrain, p));
  assert.ok(
    houseSite(
      {
        get: (x, y, z) =>
          y === 100 ? { code: 'game:snowlayer-3', boxes: [[x, y, z, x + 1, y + 0.375, z + 1]], hazard: null } : terrain.get(x, y, z),
      },
      p,
    ),
  );
  assert.equal(houseSite({ get: () => ({ boxes: [{}], hazard: 'water' }) }, p), null);
  const occupied = (code, traits = []) => ({
    get: (x, y, z) => (y === 100 ? { code, traits, boxes: [], hazard: null } : terrain.get(x, y, z)),
  });
  assert.ok(houseSite(occupied('game:flower-horsetail-free'), p), 'ground plants are cleared before construction');
  assert.ok(houseSite(occupied('game:leaves-birch', ['leaves']), p), 'visible leaves are removable cover');
  assert.equal(houseSite(occupied('game:stationarybasket-east'), p), null, 'non-colliding occupied cells are not empty construction space');
});

test('house: known level ground near camp is used even when an errand left the body far away', () => {
  const home = { x: 50.5, y: 100, z: 50.5 };
  const terrain = {
    get: (x: number, y: number, z: number) => {
      const known = x >= 24 && x <= 62 && z >= 24 && z <= 62;
      if (!known || y < 99 || y > 104) return undefined;
      return { code: y === 99 ? 'game:soil-low-none' : 'game:air', boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [], hazard: null };
    },
  };
  const memory = fresh({ home });
  const next: any = house.run({
    memory,
    reading: { terrain },
    state: { position: { x: 0.5, y: 100, z: 0.5 } },
    k: kit(inventory({})),
  } as any);
  assert.notEqual(next.start, 'explore');
  assert.ok(memory.notes.construction, 'the known camp terrain becomes a construction plan immediately');
  assert.ok(Math.hypot(memory.notes.construction!.origin.x - home.x, memory.notes.construction!.origin.z - home.z) < 30);
});

test('shelter refuses unknown ground, unsupported floors and blocked interiors', () => {
  const position = { x: 0.5, y: 100, z: 0.5 };
  const terrain = {
    get: (x, y, z) => ({ boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [], hazard: null }),
    nodeAt: () => ({ y: 100 }),
  };
  assert.ok(shelterSite(terrain, position));
  assert.ok(
    shelterSite(
      {
        ...terrain,
        get: (x, y, z) =>
          y === 100 ? { code: 'game:snowlayer-3', boxes: [[x, y, z, x + 1, y + 0.375, z + 1]], hazard: null } : terrain.get(x, y, z),
      },
      position,
    ),
    'observed removable snow can be cleared from supported ground',
  );
  assert.equal(shelterSite({ ...terrain, get: () => undefined }, position), null);
  assert.equal(shelterSite({ ...terrain, get: () => ({ boxes: [], hazard: null }) }, position), null);
  assert.equal(shelterSite({ ...terrain, get: (x, y, z) => ({ boxes: [[x, y, z, x + 1, y + 1, z + 1]], hazard: null }) }, position), null);
});

test('shelter can use a fully observed footprint around the player', () => {
  const terrain = {
    get: (x, y, z) => (x >= 0 && x < 5 && z >= 0 && z < 5 ? { boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [], hazard: null } : undefined),
    nodeAt: (x, z, y) => ((([1, 2].includes(x) && z === 5) || (x === 1 && z === 6)) && y === 100 ? { y: 100 } : null),
  };
  assert.deepEqual(shelterSite(terrain, { x: 2.5, y: 100, z: 2.5 }), { x: 0, y: 100, z: 0 });
});

test('shelter revisits observed level ground beyond hundreds of nearer unusable candidates', () => {
  const cells = new Map();
  for (let x = 0; x < 60; x++)
    for (let z = 0; z < 20; z += 2)
      for (let y = 99; y <= 102; y++) cells.set(`${x}:${y}:${z}`, { x, y, z, boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [], hazard: null });
  for (let x = 150; x < 155; x++)
    for (let z = 0; z < 5; z++)
      for (let y = 99; y <= 102; y++) cells.set(`${x}:${y}:${z}`, { x, y, z, boxes: y === 99 ? [[x, y, z, x + 1, y + 1, z + 1]] : [], hazard: null });
  const map = {
    cells,
    get: (x, y, z) => cells.get(`${x}:${y}:${z}`),
    nodeAt: (x, z, y) => ((([151, 152].includes(x) && z === 5) || (x === 151 && z === 6)) && y === 100 ? { y: 100 } : null),
  };
  assert.deepEqual(shelterSite(map, { x: 0.5, y: 110, z: 0.5 }), { x: 150, y: 100, z: 0 });
  const roof = cells.get('154:102:4');
  cells.set('154:102:4', { ...roof, code: 'game:leaves-grown5-birch', traits: ['leaves'] });
  assert.deepEqual(shelterSite(map, { x: 0.5, y: 110, z: 0.5 }), { x: 150, y: 100, z: 0 }, 'observed leaves can be cleared for the roof');
  cells.set('154:102:4', { ...roof, code: 'game:torch-basic-lit-up' });
  assert.equal(shelterSite(map, { x: 0.5, y: 110, z: 0.5 }), null, 'a non-colliding foreign block is not empty building space');
  cells.delete('154:102:4');
  assert.equal(shelterSite(map, { x: 0.5, y: 110, z: 0.5 }), null, 'unknown roof clearance is not a remembered building site');
});

test('partial shelter resumes its owned site after a controller restart', () => {
  const origin = { x: 10, y: 100, z: 20 };
  const shell = new Set(
    [
      ...shelterScaffold(origin, 'game:rammed-light-plain'),
      ...template(origin, 'game:rammed-light-plain'),
      ...shelterDoor(origin, 'game:rammed-light-plain'),
    ].map(cell => `${cell.x}:${cell.y}:${cell.z}`),
  );
  const memory = fresh(fresh({ shelter: origin }).notes);
  const ctx: any = {
    memory,
    state: { position: { x: 12.5, y: 100, z: 25.5 } },
    k: kit(inventory({ 'game:rammed-light-plain': 6, 'game:torch-basic-extinct-up': 2, 'game:firestarter': 1 })),
    reading: {
      terrain: {
        get: (x, y, z) => ({ code: shell.has(`${x}:${y}:${z}`) && !(y === 102 && z === 20) ? 'game:rammed-light-plain' : 'game:air' }),
      },
    },
  };
  const shellBlock = ctx.reading.terrain.get;
  ctx.reading.terrain.get = (x, y, z) => {
    if (x === 12 && y === 100 && z === 22) return { code: 'game:flower-horsetail-free', traits: ['plant'], boxes: [] };
    if (x === 12 && y === 101 && z === 22) return { code: 'game:leaves-grown5-birch', traits: ['leaves'], boxes: [] };
    if (x === 11 && y === 100 && z === 21) return { code: 'game:stationarybasket-east', boxes: [{}] };
    if (x === 12 && y === 100 && z === 21) return { code: 'game:torch-basic-lit-up', boxes: [] };
    return shellBlock(x, y, z);
  };
  const work: any = shelter.run(ctx);
  assert.equal(work.start, 'shelter');
  assert.deepEqual(work.args.origin, origin);
  shelter.ended!({ ok: false } as any, memory, {} as any);
  assert.deepEqual(memory.notes.shelter, origin, 'a failed roof cannot discard the already placed walls');
});

test('night finishes a nearby almost complete owned shelter before a distant old home', () => {
  const origin = { x: 10, y: 100, z: 20 };
  const material = 'game:rammed-light-plain';
  const shell = new Set(
    [...shelterScaffold(origin, material), ...template(origin, material), ...shelterDoor(origin, material)].map(c => `${c.x}:${c.y}:${c.z}`),
  );
  const memory = fresh({ shelter: origin, home: { x: 200, y: 100, z: 200 }, dwelling: { door: { x: 200, y: 100, z: 201 }, item: material } });
  const ctx: any = {
    memory,
    home: memory.notes.home,
    storm: false,
    state: { position: { x: 12.5, y: 100, z: 25.5 } },
    k: kit(inventory({ [material]: 3, 'game:firestarter': 1 })),
    reading: {
      terrain: {
        get: (x, y, z) => ({
          code:
            x === 12 && y === 100 && z === 21
              ? 'game:torch-basic-lit-up'
              : x === 10 && y === 102 && z === 20
                ? 'game:air'
                : shell.has(`${x}:${y}:${z}`)
                  ? material
                  : 'game:air',
        }),
      },
    },
  };
  const next = context => {
    const decision = goHome.run(context);
    assert.ok('start' in decision);
    return decision.start;
  };
  assert.equal(next(ctx), 'shelter');
  const approach = { ...ctx, state: { position: { x: 12.5, y: 94, z: -20 } } };
  assert.equal(next(approach), 'travel', 'approach a nearly finished starter that is much closer than the old home');
  assert.equal(next({ ...approach, home: { x: 12.5, y: 94, z: -10 } }), 'enter_shelter', 'a closer existing home still wins');
  assert.equal(next({ ...ctx, state: { position: { x: 12.5, y: 100, z: -50 } } }), 'enter_shelter', 'distant construction waits for daylight');
  assert.equal(next({ ...ctx, storm: true }), 'enter_shelter', 'a storm still requires the existing shelter');
  const get = ctx.reading.terrain.get;
  ctx.reading.terrain.get = (x, y, z) => (x === 10 && y === 102 && z === 20 ? { code: 'game:chest-east' } : get(x, y, z));
  assert.equal(next(ctx), 'enter_shelter', 'foreign occupancy must not turn night completion into a new site search');
  goHome.ended!({ kind: 'shelter', ok: true, result: { home: { x: 12.5, y: 100, z: 22.5 }, origin, item: material } } as any, memory, {} as any);
  assert.deepEqual(memory.notes.starter, origin);
});

test('a remembered shelter footprint is abandoned when storage blocks the aisle', () => {
  const origin = { x: 10, y: 100, z: 20 };
  const memory = fresh({ shelter: origin });
  const work: any = shelter.run({
    memory,
    state: { position: { x: 12.5, y: 100, z: 25.5 } },
    k: kit(inventory({ 'game:rammed-light-plain': 60, 'game:torch-basic-extinct-up': 1, 'game:firestarter': 1 })),
    reading: {
      terrain: {
        get: (x, y, z) => (x === 12 && y === 100 && z === 22 ? { code: 'game:stationarybasket-east', boxes: [{}] } : undefined),
      },
    },
  } as any);
  assert.equal(memory.notes.shelter, null);
  assert.equal(work.start, 'explore', 'unknown terrain is surveyed before choosing a replacement footprint');
});

test('restart inside an owned shelter does not identify its roof as a burrow mouth', () => {
  const home = { x: 11.5, y: 100, z: 21.5 };
  const memory = fresh({ home, dwelling: { door: { x: 11, y: 100, z: 22 }, item: 'soil-' } });
  assert.equal(recoverBurrow({ state: { position: home }, now: 1000 } as any, memory), null);
  assert.equal(memory.burrow, null);
  assert.equal(memory.startupChecked, true);
});

test('stockpile: keeps the carried kit and reopens stale shared storage', () => {
  const memory = fresh({ stash: chest });
  const ctx: any = { memory, now: 1100, state: { position: { x: 1, y: 100, z: 0 } }, k: kit(inventory({ 'game:stick': 4 })) };
  const gather: any = stockpile.run(ctx);
  assert.equal(gather.start, 'gather');
  assert.equal(gather.args.count, 32);
  ctx.k = kit(inventory({ 'game:stick': 36 }));
  const deposit: any = stockpile.run(ctx);
  assert.equal(deposit.start, 'store_items');
  assert.deepEqual(deposit.args.items, [{ item: 'game:stick', count: 32 }]);
  ctx.now = 400000;
  assert.equal((stockpile.run(ctx) as any).start, 'inspect_container');
  memory.notes.stash!.seen!.items = Object.fromEntries(SUPPLIES.map(s => [s.item, s.count]));
  stockpile.ended!({ kind: 'inspect_container', ok: true, result: { contents: [] } } as any, memory, { now: 400000 } as any);
  assert.deepEqual(memory.notes.stash!.seen!.items, {}, 'a teammate taking supplies invalidates prior counts');
});

test('stockpile: remembered supplies survive changing to an additional chest', () => {
  const first = { ...chest, full: true, seen: { at: 1000, items: { 'game:stick': 32 } } };
  const second = { ...chest, x: 2, key: 'block:0:2:100:0:game:stationarybasket-east', seen: { at: 1000, items: {} } };
  const memory = fresh({ stash: second, stores: [first] });
  const ctx: any = { memory, now: 1100, state: { position: { x: 1, y: 100, z: 0 } }, k: kit(inventory({ 'game:stick': 4 })) };
  const work: any = stockpile.run(ctx);
  assert.equal(work.start, 'gather');
  assert.equal(work.args.item, 'game:flint', 'sticks already stored in the first chest are not gathered again');
  assert.deepEqual(fresh(memory.notes).notes.stores?.[0].seen, first.seen);
});

test('home maintenance repairs observed shell gaps, never unknown cells or the open doorway', () => {
  const notes = { home: { x: 2.5, y: 100, z: 2.5 }, starter: { x: 0, y: 100, z: 0 }, stash: null };
  const reading = {
    terrain: {
      get: (x, y, z) => {
        if (x === 0 && y === 100 && z === 1) return { code: null, boxes: [], hazard: null };
        if (x === 2 && z === 4 && y < 102) return { code: 'game:air', boxes: [], hazard: null };
        if (x === 4) return { code: 'game:stone-granite', boxes: [[0, 0, 0, 1, 1, 1]], hazard: null };
        return undefined;
      },
    },
  };
  const cells = homeDamage(reading, notes);
  assert.deepEqual(cells, [{ x: 0, y: 100, z: 1, item: 'game:rammed-light-plain' }]);
  const ctx = { reading, memory: { notes }, k: { slots: [{ code: 'game:rammed-light-plain', quantity: 1 }] }, s: {} };
  const decision: any = repairHome.run(ctx as any);
  assert.equal(decision.start, 'build');
  assert.deepEqual(decision.args.cells, cells);
  ctx.k.slots = [];
  ctx.s = { night: true };
  assert.ok('wait' in repairHome.run(ctx as any), 'no nighttime gathering for repairs');
  const extensive: any = repairHome.run({
    ...ctx,
    reading: { terrain: { get: () => ({ code: 'game:air', boxes: [], hazard: null }) } },
    k: { slots: [{ code: 'game:rammed-light-plain', quantity: 64 }] },
  } as any);
  assert.equal(extensive.args.cells.length, 8, 'large repairs must fit the public build request limit');
  assert.deepEqual(
    extensive.args.cells.slice(0, 3),
    shelterScaffold(notes.starter, 'game:rammed-light-plain'),
    'restore roof access before the shell',
  );
});

test('bag preparation counts recoverable grid tops before gathering more', () => {
  const decision = makeBag({
    k: { cattailtops: 9 },
    reading: { inventory: { inventories: [{ name: 'craftinggrid', slots: [{ slot: 0, code: 'game:cattailtops', quantity: 1 }] }] } },
  });
  assert.equal(decision.start, 'craft_item');
  assert.equal(decision.args.output, 'game:basket-normal-reed');
});

test('bag preparation stages a basket out of backpack contents before wearing it', () => {
  const state = 'ab'.repeat(32);
  const basket = { inventory: 'backpack', slot: 8 };
  const bagSlot = { inventory: 'backpack', slot: 1 };
  const staged = makeBag({
    k: {
      bagItem: basket,
      emptyBagSlot: bagSlot,
      cattailtops: 0,
      state,
      slots: [
        { inventory: 'hotbar', slot: 0, code: null, quantity: 0 },
        { inventory: 'backpack', slot: 1, code: null, quantity: 0, bag: true },
        { inventory: 'backpack', slot: 8, code: 'game:basket-normal-reed', quantity: 1 },
      ],
    },
    reading: { inventory: { inventories: [] }, state: { activeSlot: 2 } },
  });
  assert.deepEqual(staged.act, [{ action: 'move_item', from: basket, to: { inventory: 'hotbar', slot: 0 }, quantity: 1, expectedState: state }]);

  const room = makeBag({
    k: {
      bagItem: basket,
      emptyBagSlot: bagSlot,
      cattailtops: 0,
      state,
      slots: [
        { inventory: 'hotbar', slot: 0, code: 'game:stick', quantity: 3 },
        { inventory: 'hotbar', slot: 1, code: 'game:knife-flint', quantity: 1, tool: 'Knife' },
        { inventory: 'backpack', slot: 1, code: null, quantity: 0, bag: true },
        { inventory: 'backpack', slot: 8, code: 'game:basket-normal-reed', quantity: 1 },
        { inventory: 'backpack', slot: 9, code: null, quantity: 0 },
      ],
    },
    reading: { inventory: { inventories: [] }, state: { activeSlot: 1 } },
  });
  assert.deepEqual(room.act, [
    {
      action: 'move_item',
      from: { inventory: 'hotbar', slot: 0 },
      to: { inventory: 'backpack', slot: 9 },
      quantity: 3,
      expectedState: state,
    },
  ]);
});
