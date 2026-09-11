import { collectStick } from './collect-stick.mjs';
import { gather } from './gather.mjs';
import { forage, eat } from './forage.mjs';
import { blockGoal } from './blocks.mjs';
import { equipGoal, collectItemGoal } from './inventory.mjs';
import { craftGoal, harvestGoal, fellTreeGoal, useGoal, travelGoal, exploreGoal, digAreaGoal, buildGoal, knapGoal, clayformGoal } from './work.mjs';

// Public argument contracts live in controller/actions.mjs; handlers compose runtime skills.
export const goalHandlers = new Map([
  ['move_to', (runtime, args, record, started) => runtime.navigate(args, record, started)],
  ['collect_stick', (runtime, args, record, started) => runtime.runTask(env => collectStick(env.send), args, record, started)],
  ['gather_sticks', (runtime, args, record, started) => runtime.runTask(gather, args, record, started)],
  ['forage', (runtime, args, record, started) => runtime.runTask(forage, args, record, started)],
  ['eat', (runtime, args, record, started) => runtime.runTask(eat, args, record, started)],
  ['equip', (runtime, args, record, started) => runtime.runTask(equipGoal, args, record, started)],
  ['collect_item', (runtime, args, record, started) => runtime.runTask(collectItemGoal, args, record, started)],
  ['dig_block', (runtime, args, record, started) => runtime.runTask((env, options) => blockGoal(env, 'dig', options), args, record, started)],
  ['place_block', (runtime, args, record, started) => runtime.runTask((env, options) => blockGoal(env, 'place', options), args, record, started)],
  ['craft_item', (runtime, args, record, started) => runtime.runTask(craftGoal, args, record, started)],
  ['harvest', (runtime, args, record, started) => runtime.runTask(harvestGoal, args, record, started)],
  ['fell_tree', (runtime, args, record, started) => runtime.runTask(fellTreeGoal, args, record, started)],
  ['use_on_block', (runtime, args, record, started) => runtime.runTask(useGoal, args, record, started)],
  ['travel', (runtime, { poi, ...args }, record, started) => {
    const point = poi === undefined ? args : runtime.pois.get(poi);
    if (!point) throw Error('Unknown poi; see pois');
    return runtime.runTask(travelGoal, { ...args, x: point.x, y: point.y, z: point.z }, record, started);
  }],
  ['explore', (runtime, args, record, started) => runtime.runTask(exploreGoal, args, record, started)],
  ['dig_area', (runtime, args, record, started) => runtime.runTask(digAreaGoal, args, record, started)],
  ['build', (runtime, args, record, started) => runtime.runTask(buildGoal, args, record, started)],
  ['knap', (runtime, args, record, started) => runtime.runTask(knapGoal, args, record, started)],
  ['clayform', (runtime, args, record, started) => runtime.runTask(clayformGoal, args, record, started)],
]);

// Controller-local actions: no goal, no bridge round trip beyond an optional observe.
export const localHandlers = new Map([
  ['set_poi', async (runtime, { name, note, ...point }) => {
    if (point.x === undefined) {
      const state = await runtime.send({ action: 'observe' });
      if (!state.ok) return state;
      point = { x: state.position.x, y: state.position.y, z: state.position.z };
    }
    runtime.pois.set(name, { ...point, note, at: Date.now() });
    while (runtime.pois.size > 64) runtime.pois.delete(runtime.pois.keys().next().value);
    return { ok: true, name, ...runtime.pois.get(name) };
  }],
  ['pois', async runtime => ({ ok: true, pois: Object.fromEntries(runtime.pois) })],
]);
