import assert from 'node:assert/strict';
import { test } from 'node:test';
import { plant } from '../src/goals/plant.ts';
import { cropRequirements, farmlandReadings, plantingProblem } from '../src/support/crops.ts';

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
