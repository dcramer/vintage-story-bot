import { Fieldwork } from '../skills/fieldwork.mjs';
import { consume } from '../skills/food.mjs';
import { Survival } from '../skills/survival.mjs';

export async function forage(env, options = {}) {
  const field = new Fieldwork(env, options);
  try {
    await field.start(['forage_state', 'food_freshness']);
    const survival = new Survival(field);
    await survival.tend({ force: true });
    return { ok: true, goal: 'forage', eaten: survival.eaten, harvested: survival.harvested,
      reserve: survival.reserve, moved: +field.moved.toFixed(1), searched: field.searched };
  } finally {
    await env.send({ action: 'stop' });
  }
}

export async function eat(env, options = {}) {
  const field = new Fieldwork(env, options);
  try {
    await field.start(['food_freshness']);
    return { ok: true, goal: 'eat', ...await consume(field) };
  } finally {
    await env.send({ action: 'stop' });
  }
}
