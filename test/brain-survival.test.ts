import assert from 'node:assert/strict';
import { test } from 'node:test';
import { recoverBurrow } from '../src/brain/default/reflexes/burrow.ts';
import { makeBag } from '../src/brain/default/tasks/bags.ts';
import { house, houseSite } from '../src/brain/default/tasks/house.ts';
import { lightingDay, shelterLight } from '../src/brain/default/tasks/lighting.ts';
import { recoverableBody } from '../src/brain/default/tasks/recover.ts';
import { homeDamage, repairHome } from '../src/brain/default/tasks/repair_home.ts';
import { shelter } from '../src/brain/default/tasks/shelter.ts';
import { SUPPLIES, stockpile } from '../src/brain/default/tasks/stockpile.ts';
import { fresh, kit } from '../src/brain/default.ts';
import craft from '../src/goals/craft_item.ts';
import buildHouse from '../src/goals/house.ts';
import { shelterSite } from '../src/goals/shelter.ts';
import { shelterDoor, shelterStorage, shelterTorches, shelter as template } from '../src/support/structures.ts';

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
  const storage = shelterStorage(origin);
  assert.equal(storage.length, 6);
  for (const cell of storage) {
    assert.ok(cell.x === 1 || cell.x === 3, 'chests leave the center aisle clear');
    assert.ok(!keys.has(`${cell.x},${cell.y},${cell.z}`), 'chest slots are inside the shell');
  }
  for (let x = 0; x < 5; x++) for (let z = 0; z < 5; z++) assert.ok(keys.has(`${x},102,${z}`), 'sealed roof');
  for (const torch of shelterTorches(origin)) assert.ok(!keys.has(`${torch.x},${torch.y},${torch.z}`), 'torch is inside clear space');
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
  ctx.k = kit(inventory({ 'game:rammed-light-plain': 6 }));
  const walls: any = house.run(ctx);
  assert.equal(walls.start, 'house');
  buildHouse.schema.parse(walls.args);
  const partial: any = { kind: 'house', ok: false, reason: 'out_of_material' };
  house.ended!(partial, memory, {} as any);
  assert.equal(house.setAside!(partial, memory, {} as any), false);
  assert.equal(memory.notes.home, null);
  assert.equal(fresh(memory.notes).notes.construction?.phase, 'walls');
  house.ended!({ kind: 'house', ok: true } as any, memory, {} as any);
  assert.equal(memory.notes.construction?.phase, 'floor');
  assert.equal(memory.notes.home, null, 'a roof alone is not a finished home');
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
    nodeAt: (x, z, y) => (x === 2 && z === 5 && y === 100 ? { y: 100 } : null),
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
  const map = { cells, get: (x, y, z) => cells.get(`${x}:${y}:${z}`), nodeAt: (x, z, y) => (x === 152 && z === 5 && y === 100 ? { y: 100 } : null) };
  assert.deepEqual(shelterSite(map, { x: 0.5, y: 110, z: 0.5 }), { x: 150, y: 100, z: 0 });
  cells.delete('154:102:4');
  assert.equal(shelterSite(map, { x: 0.5, y: 110, z: 0.5 }), null, 'unknown roof clearance is not a remembered building site');
});

test('partial shelter resumes its owned site after a controller restart', () => {
  const origin = { x: 10, y: 100, z: 20 };
  const shell = new Set(
    [...template(origin, 'game:rammed-light-plain'), ...shelterDoor(origin, 'game:rammed-light-plain')].map(cell => `${cell.x}:${cell.y}:${cell.z}`),
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
