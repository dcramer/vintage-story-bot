import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Fieldwork } from '../src/skills/fieldwork.mjs';
import { mushroomCode, ripeForage, safeFood } from '../src/skills/food.mjs';

const slot = code => ({ code, quantity: 1, nutrition: { saturation: 80, health: 0 },
  freshness: { state: 'fresh', freshHoursLeft: 100 } });

test('deterministic forage allowlist rejects poisonous and psychedelic mushrooms', () => {
  assert.equal(mushroomCode('game:mushroom-chanterelle-normal'), true);
  assert.equal(mushroomCode('game:mushroom-deathcap-normal'), false);
  assert.equal(mushroomCode('game:mushroom-goldcap-normal'), false);
  assert.equal(safeFood(slot('game:mushroom-chanterelle-normal')), true);
  assert.equal(safeFood(slot('game:mushroom-deathcap-normal')), false);
  assert.equal(safeFood({ ...slot('game:mushroom-chanterelle-normal'), nutrition: { saturation: 80, health: -1 } }), false);
  assert.equal(ripeForage({ kind: 'block', forage: { ripe: true, foodCode: 'game:mushroom-chanterelle-normal' } }), true);
});

test('low health is tolerated only during explicit starving food recovery', () => {
  const field = new Fieldwork({});
  const state = alerts => ({ life: { alerts } });
  assert.equal(field.alertsSafe(state(['low_food'])), true);
  assert.equal(field.alertsSafe(state(['low_food', 'low_health'])), false);
  field.recoveringFood = true;
  assert.equal(field.alertsSafe(state(['low_food', 'low_health'])), true);
  assert.equal(field.alertsSafe(state(['low_health'])), false);
  assert.equal(field.alertsSafe(state(['low_food', 'on_fire'])), false);
});
