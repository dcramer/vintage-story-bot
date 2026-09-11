import { Fieldwork } from '../skills/fieldwork.mjs';
import { equip } from '../skills/inventory.mjs';
import { collectItem } from '../skills/collect-item.mjs';

async function run(env, options, skill) {
  const field = new Fieldwork(env, options);
  try {
    await field.start(['inventory']);
    return await skill(field, options);
  } finally {
    await env.send({ action: 'stop' });
  }
}

export const equipGoal = (env, options) => run(env, options, equip);
export const collectItemGoal = (env, options) => run(env, options, collectItem);
