import { Fieldwork } from '../skills/fieldwork.mjs';
import { Survival } from '../skills/survival.mjs';
import { craftItem } from '../skills/craft.mjs';
import { harvest } from '../skills/harvest.mjs';
import { useOnBlock } from '../skills/use.mjs';
import { travel } from '../skills/travel.mjs';
import { digArea, build } from '../skills/build.mjs';
import { box, presets } from '../skills/structures.mjs';
import { form } from '../skills/forming.mjs';

const food = ['forage_state', 'food_freshness', 'block_actions'];

async function run(env, options, capabilities, work) {
  const { manageFood = false, ...rest } = options;
  const field = new Fieldwork(env, rest);
  const survival = manageFood ? new Survival(field) : null;
  field.recoveringFood = manageFood;
  try {
    await field.start([...capabilities, ...(manageFood ? food : [])]);
    return await work(field, survival, rest);
  } finally {
    await env.send({ action: 'stop' });
  }
}

export const craftGoal = (env, options) => run(env, options, ['inventory', 'grid_craft'], (field, _, o) => craftItem(field, o));
export const harvestGoal = (env, options) => run(env, { manageFood: true, ...options }, ['inventory', 'block_actions'], harvest);
export const fellTreeGoal = (env, { count = 8, ...options }) => run(env, { manageFood: true, ...options }, ['inventory', 'block_actions'],
  (field, survival, o) => harvest(field, survival, { ...o, match: 'log-grown', item: 'game:log-', tool: 'Axe', count, lowest: true })
    .then(result => ({ ...result, goal: 'fell_tree' })));
export const useGoal = (env, options) => run(env, options, ['inventory', 'sneak'], (field, _, o) => useOnBlock(field, o));
export const digAreaGoal = (env, { cells, box: bounds, ...options }) => run(env, options, ['inventory', 'block_actions'],
  (field, survival, o) => digArea(field, survival, { ...o, cells: cells ?? box(bounds.from, bounds.to) }));
export const buildGoal = (env, { cells, preset, ...options }) => run(env, options, ['inventory', 'block_actions'],
  (field, survival) => build(field, survival, { cells: cells ?? presets[preset.kind](preset.origin, preset.item) }));
export const knapGoal = (env, options) => run(env, options, ['inventory', 'sneak', 'forming'], (field, _, o) => form(field, { ...o, kind: 'knapping' }));
export const clayformGoal = (env, options) => run(env, options, ['inventory', 'sneak', 'forming'], (field, _, o) => form(field, { ...o, kind: 'clayforming' }));
export const travelGoal = (env, options) => run(env, { manageFood: true, ...options }, [], travel);
export const exploreGoal = (env, { legs = 4, heading, ...options }) => run(env, { manageFood: true, ...options }, [],
  async (field, survival) => {
    if (heading !== undefined) field.heading = heading;
    const results = [];
    for (let i = 0; i < legs; i++) {
      await survival?.tend();
      field.report('exploring', { leg: i + 1, legs });
      const result = await field.walk(field.explore(), survival?.yieldWhen);
      results.push(result.state);
      await field.scan(64, '', 'all');
    }
    const sightings = {};
    for (const o of field.seen.values()) sightings[o.code] = (sightings[o.code] ?? 0) + 1;
    return { ok: true, goal: 'explore', legs: results, moved: +field.moved.toFixed(1), position: field.latest.position, heading: field.heading,
      sightings: Object.fromEntries(Object.entries(sightings).sort((a, b) => b[1] - a[1]).slice(0, 48)) };
  });
