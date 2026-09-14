import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kit } from '../src/brain/default/situation.ts';
import { farm, farmDue } from '../src/brain/default/tasks/farm.ts';
import { surplusOf } from '../src/brain/default/tasks/stash.ts';
import { hoe } from '../src/brain/default/tasks/tools.ts';
import { allocate } from '../src/goals/craft_item.ts';
import { plant } from '../src/goals/plant.ts';
import { TerrainMemory } from '../src/runtime/navigation/terrain.ts';
import { cropRequirements, FARM_SOIL, farmlandReadings, plantingProblem } from '../src/support/crops.ts';
import {
  farmApproach,
  farmBeds,
  farmCell,
  farmFence,
  farmGate,
  farmGroundwork,
  farmMargin,
  farmSite,
  farmSurveySite,
  farmWatered,
  fertileBed,
  workableFarmFloor,
} from '../src/support/farming.ts';

function shoreline(turn = 0) {
  const map = new TerrainMemory();
  const plan = { origin: { x: 20, y: 100, z: 20 }, turn, soil: 'game:soil-medium-none', wood: 'pine', rotation: 0, prepared: false, checkedAt: 0 };
  for (const p of farmMargin(plan))
    for (let dy = -1; dy < 2; dy++) {
      const y = p.y + dy;
      map.put({
        ...p,
        y,
        seenAt: Date.now(),
        traits: [],
        code: dy === -1 ? 'game:soil-low-normal' : undefined,
        boxes: dy === -1 ? [[p.x, y, p.z, p.x + 1, y + 1, p.z + 1]] : [],
      });
    }
  for (let x = 1; x <= 4; x++)
    map.put({ ...farmCell(plan, x, -1, -1), seenAt: Date.now(), traits: ['water'], code: 'game:water-still-7', boxes: [] });
  return { map, plan };
}

test('all farm orientations keep eight dry beds irrigated behind a complete 15-fence perimeter', () => {
  for (let turn = 0; turn < 4; turn++) {
    const { map, plan } = shoreline(turn);
    assert.equal(farmFence(plan).length, 15);
    assert.equal(farmBeds(plan).length, 8);
    assert.ok(farmWatered(map, plan));
    assert.deepEqual(farmSite(map, farmApproach(plan)), { origin: plan.origin, turn });
    const blocked = farmCell(plan, -1, 1);
    map.put({
      ...blocked,
      seenAt: Date.now(),
      traits: [],
      code: 'game:soil-low-normal',
      boxes: [[blocked.x, blocked.y, blocked.z, blocked.x + 1, blocked.y + 1, blocked.z + 1]],
    });
    assert.ok(
      farmGroundwork(map, plan)?.clear.some(cell => cell.x === blocked.x && cell.y === blocked.y && cell.z === blocked.z),
      'raised natural ground beside fencing becomes explicit grading work',
    );
    assert.deepEqual(farmSite(map, farmApproach(plan)), { origin: plan.origin, turn });
  }
  const { map, plan } = shoreline();
  for (let x = 1; x <= 4; x++) {
    const water = farmCell(plan, x, -1, -1);
    map.put({ ...water, seenAt: Date.now(), traits: ['water'], code: 'game:saltwater-still-7', boxes: [] });
  }
  assert.equal(farmWatered(map, plan), false, 'saltwater cannot irrigate');
  assert.equal(farmSite(map, farmApproach(plan)), null);
  const ice = farmCell(plan, 1, -1, -1);
  map.put({ ...ice, seenAt: Date.now(), traits: [], code: 'game:lakeice', boxes: [[ice.x, ice.y, ice.z, ice.x + 1, ice.y + 1, ice.z + 1]] });
  assert.equal(farmWatered(map, plan), true, 'one observed lake-ice source waters every bed within three blocks');
  assert.deepEqual(farmSite(map, farmApproach(plan)), { origin: plan.origin, turn: 0 });
  for (let x = 0; x < 6; x++)
    for (let z = 0; z < 4; z++) {
      const p = farmCell(plan, x, z, -1);
      map.put({ ...p, seenAt: Date.now(), traits: [], code: 'game:sand-claystone', boxes: [[p.x, p.y, p.z, p.x + 1, p.y + 1, p.z + 1]] });
    }
  assert.deepEqual(farmSite(map, farmApproach(plan)), { origin: plan.origin, turn: 0 }, 'the carried bed soil makes a flat sand shore usable');
  assert.ok(workableFarmFloor(map.get(plan.origin.x, plan.origin.y - 1, plan.origin.z), plan.origin.y));
  assert.equal(farmSite(new TerrainMemory(), plan.origin), null, 'unknown ground never authorizes a farm');
  assert.equal(fertileBed('game:farmland-moist-low'), false);
  assert.equal(fertileBed('game:farmland-moist-medium'), true);
});

test('a farm shoreline is surveyed before unknown margin cells authorize grading', () => {
  const { map, plan } = shoreline();
  const unknown = farmCell(plan, -2, -2);
  map.forget(`${unknown.x},${unknown.y},${unknown.z}`);
  assert.equal(farmSite(map, farmApproach(plan)), null);
  const survey = farmSurveySite(map, farmApproach(plan));
  assert.ok(survey, 'known freshwater and foundation permit a close survey of the unseen margin');

  const surveyPlan = { ...plan, ...survey };
  const center = farmCell(surveyPlan, 2, 2);
  const memory = { notes: { farm: { ...surveyPlan, surveyed: false } } } as any;
  const decision: any = farm.run({
    k: kit({ state: 'test', inventories: [] }),
    memory,
    reading: { terrain: map },
    state: { position: { ...center, x: center.x + 0.5, z: center.z + 0.5 } },
  } as any);
  assert.equal(decision.start, 'look_around');
  farm.ended({ kind: 'look_around', ok: true } as any, memory, { now: 1, terrain: map } as any);
  assert.equal(memory.notes.farm.surveyed, true);
});

test('farm grading clears rises and fills shoreline cells from existing support', () => {
  const { map, plan } = shoreline();
  const raised = farmCell(plan, 0, 0);
  map.put({
    ...raised,
    seenAt: Date.now(),
    traits: ['diggable'],
    code: 'game:soil-low-none',
    boxes: [[raised.x, raised.y, raised.z, raised.x + 1, raised.y + 1, raised.z + 1]],
  });
  const fill = farmCell(plan, 0, 1, -1);
  map.put({ ...fill, seenAt: Date.now(), traits: [], code: 'game:air', boxes: [] });
  const work = farmGroundwork(map, plan);
  assert.ok(work?.clear.some(cell => cell.x === raised.x && cell.y === raised.y && cell.z === raised.z));
  assert.ok(work?.fill.some(cell => cell.x === fill.x && cell.y === fill.y && cell.z === fill.z));

  const inventory = {
    state: 'test',
    inventories: [{ name: 'hotbar', slots: [{ slot: 0, code: 'game:soil-low-none', quantity: 8 }] }],
  };
  const context = {
    k: kit(inventory),
    memory: { notes: { farm: plan } },
    reading: { terrain: map },
    state: { position: farmApproach(plan) },
  } as any;
  const platform: any = farm.run(context);
  assert.equal(platform.start, 'build', 'the dry platform is placed before clearing work that is only reachable across it');
  assert.deepEqual(platform.args.cells, [{ ...fill, item: 'game:soil-low-none' }]);

  map.put({
    ...fill,
    seenAt: Date.now(),
    traits: [],
    code: 'game:lakeice',
    boxes: [[fill.x, fill.y, fill.z, fill.x + 1, fill.y + 1, fill.z + 1]],
  });
  const blocker: any = farm.run(context);
  assert.equal(blocker.start, 'dig_area', 'solid seasonal footing is removed before its platform cell is filled');
  assert.deepEqual(blocker.args.cells, [fill]);
});

test('farm supplies come from the chest before gathering, and stay in the working kit', () => {
  const { map, plan } = shoreline(1);
  const inventory = slots => ({ state: 'test', inventories: [{ name: 'hotbar', slots: slots.map((s, slot) => ({ ...s, slot })) }] });
  const chest = { key: 'chest', x: 100, y: 100, z: 100, code: 'game:stationarybasket-east', seen: { at: 0, items: { [plan.soil]: 64 } } };
  const ctx = {
    k: kit(inventory([])),
    memory: { notes: { farm: plan, stash: chest } },
    reading: { terrain: map },
    state: { position: chest },
    home: chest,
  } as any;
  const take = farm.run(ctx);
  assert.ok('start' in take && take.start === 'take_items', 'standing at the chest must fetch, not travel back to the farm');
  assert.deepEqual(take.args.items, [{ item: plan.soil, count: 8 }]);
  ctx.k = kit(
    inventory([
      { code: plan.soil, quantity: 64 },
      { code: 'game:roughhewnfence-pine-ew-free', quantity: 16 },
      { code: 'game:log-grown-pine-ud', quantity: 4 },
      { code: 'game:stick', quantity: 4 },
      { code: 'game:seeds-rye', quantity: 6 },
    ]),
  );
  const gate = farm.run(ctx);
  assert.ok('start' in gate && gate.start === 'craft_item');
  assert.equal(
    gate.args.output,
    'game:roughhewnfencegate-pine-n-closed-free',
    'the native gate recipe has one output, independent of placement orientation',
  );
  const surplus = surplusOf(ctx.k, { home: true, torches: 1, farming: true });
  assert.ok(surplus.some(s => s.item === plan.soil && s.count === 56));
  assert.ok(surplus.some(s => s.item === 'game:seeds-rye' && s.count === 4));
  assert.ok(!surplus.some(s => s.item.includes('roughhewnfence')));
});

test('farm shoreline exploration stays inside the home search area', () => {
  const home = { x: 0, y: 100, z: 0 };
  const choice = farm.run({
    k: kit({ state: 'test', inventories: [] }),
    memory: { notes: {} },
    reading: { terrain: new TerrainMemory() },
    state: { position: { x: 100, y: 100, z: 0 } },
    home,
  } as any);
  assert.ok('start' in choice && choice.start === 'travel');
  assert.deepEqual(choice.args, { x: 0, z: 0, arrivalRadius: 8, manageFood: false, timeoutMs: 900000 });
  assert.equal(choice.why, 'returning to the farm search area, 100 blocks away');
});

test('farm rotation follows a verified completed harvest, and observed fence damage triggers repair', () => {
  const { map, plan } = shoreline();
  const memory = { notes: { farm: plan } } as any;
  farm.ended({ kind: 'farm', ok: false, result: { rotate: true } } as any, memory, { now: 1000 } as any);
  assert.equal(plan.rotation, 0);
  farm.ended({ kind: 'farm', ok: true, result: { prepared: true, rotate: true } } as any, memory, { now: 1000 } as any);
  assert.equal(plan.rotation, 1);
  assert.equal(plan.checkedAt, 0);
  plan.checkedAt = 1000;
  for (const p of [...farmFence(plan), farmGate(plan)])
    map.put({ ...p, seenAt: Date.now(), traits: [], code: 'game:roughhewnfence-pine-ew-free', boxes: [] });
  assert.equal(farmDue({ now: 1001, terrain: map }, plan), false);
  const missing = farmFence(plan)[0];
  map.put({ ...missing, seenAt: Date.now(), traits: [], boxes: [] });
  assert.equal(farmDue({ now: 1001, terrain: map }, plan), true);
});

const rye = {
  class: 'ItemPlantableSeed',
  text: [
    'Required Nutrient: N',
    'Nutrient Consumption: 35',
    'Growth Time:  16 days',
    'Cold resistant until -12 °C',
    'Heat resistant until 27 °C',
    '[game:crop-rye-1]',
  ],
};

test('farm hoe is knapped and hafted from its actual carried material', () => {
  const inventory = slots => ({ state: 'test', inventories: [{ name: 'hotbar', slots: slots.map((s, slot) => ({ ...s, slot })) }] });
  const knap = hoe.run({
    k: kit(
      inventory([
        { code: 'game:flint', quantity: 2 },
        { code: 'game:stick', quantity: 1 },
      ]),
    ),
  } as any);
  assert.ok('start' in knap && knap.start === 'knap');
  assert.equal(knap.args.output, 'game:hoehead-flint');
  const haft = hoe.run({
    k: kit(
      inventory([
        { code: 'game:hoehead-granite', quantity: 1 },
        { code: 'game:stick', quantity: 1 },
      ]),
    ),
  } as any);
  assert.ok('start' in haft && haft.start === 'craft_item');
  assert.equal(haft.args.output, 'game:hoe-granite');
});

test('fertile soil is stored for beds, never selected by construction crafting', () => {
  const inventory = {
    state: 'test',
    inventories: [
      {
        name: 'hotbar',
        slots: [
          { slot: 0, code: 'game:soil-medium-none', quantity: 64 },
          { slot: 1, code: 'game:soil-low-none', quantity: 12 },
        ],
      },
    ],
  };
  const k = kit(inventory);
  assert.equal(k.buildingMaterials, 12);
  assert.ok(surplusOf(k, { home: true, torches: 1, building: true }).some(s => s.item === 'game:soil-medium-none' && s.count === 64));
  const recipe = { ingredients: [{ slot: 0, quantity: 6, matches: inventory.inventories[0].slots.map(s => ({ ...s, inventory: 'hotbar' })) }] };
  assert.equal(allocate(recipe, 1, inventory, FARM_SOIL)[0].from.slot, 1);
  assert.equal(allocate(recipe, 3, inventory, FARM_SOIL), null, 'insufficient building soil cannot consume the farm reserve');
});

test('planting uses live handbook requirements and refuses unknown or depleted soil', () => {
  const crop = cropRequirements(rye);
  assert.deepEqual(crop, { nutrient: 'N', consumption: 35, days: 16, cold: -12, heat: 27, crop: 'game:crop-rye-1' });
  assert.equal(cropRequirements({ ...rye, text: ['Required Nutrient: N'] }), null);
  const soil = farmlandReadings('Nutrient Levels: 50% N, 25% P, 50% K\nMoisture: <font color="#fff">50%</font>');
  const weather = { climate: { temperatureC: 12 } };
  assert.equal(plantingProblem(crop, weather, soil), null);
  assert.equal(plantingProblem(crop, weather, { ...soil, nutrients: { ...soil.nutrients, N: 20 } }), 'depleted_nutrient');
  assert.equal(plantingProblem(crop, weather, { ...soil, moisture: 0 }), 'dry_farmland');
  assert.equal(plantingProblem(crop, {}, soil), 'unknown_temperature');
  assert.equal(plantingProblem(crop, weather, farmlandReadings('unrecognized HUD text')), 'unknown_farmland');
});

test('cold tolerance is not permission to plant when nothing can grow', async () => {
  const calls = [];
  const result = await plant(
    {
      send: async args => {
        calls.push(args.action);
        return args.action === 'item_info' ? rye : { climate: { temperatureC: -7 } };
      },
    },
    { target: 'block:0:1:100:1:game:soil-medium-none', item: 'game:seeds-rye' },
  );
  assert.equal(result.reason, 'unsuitable_temperature');
  assert.deepEqual(calls, ['item_info', 'environment'], 'no tilling or seed mutation is attempted in winter');
});
