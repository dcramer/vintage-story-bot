import assert from 'node:assert/strict';
import { test } from 'node:test';
import { house, houseSite } from '../src/brain/default/tasks/house.ts';
import { recoverableBody } from '../src/brain/default/tasks/recover.ts';
import { shelter } from '../src/brain/default/tasks/shelter.ts';
import { SUPPLIES, stockpile } from '../src/brain/default/tasks/stockpile.ts';
import { fresh, kit } from '../src/brain/default.ts';
import craft from '../src/goals/craft_item.ts';
import buildHouse from '../src/goals/house.ts';
import { shelterSite } from '../src/goals/shelter.ts';

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
  const terrain = { get: (_x: number, y: number) => ({ boxes: y === 99 ? [{}] : [], hazard: null }) };
  assert.ok(houseSite(terrain, p));
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

test('partial shelter resumes its owned site after a controller restart', () => {
  const origin = { x: 10, y: 100, z: 20 };
  const memory = fresh(fresh({ shelter: origin }).notes);
  const ctx: any = { memory, state: { position: { x: 11.5, y: 100, z: 23.5 } }, k: { dirt: 6 } };
  const work: any = shelter.run(ctx);
  assert.equal(work.start, 'shelter');
  assert.deepEqual(work.args.origin, origin);
  shelter.ended!({ ok: false } as any, memory, {} as any);
  assert.deepEqual(memory.notes.shelter, origin, 'a failed roof cannot discard the already placed walls');
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
