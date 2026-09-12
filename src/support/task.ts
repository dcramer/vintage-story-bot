import { Fieldwork } from './fieldwork.ts';
import { Survival } from './survival.ts';

export const foodFeatures = ['block_facts', 'item_info', 'food_freshness', 'block_actions'];

// Standard goal session: guarded Fieldwork start with required mod feature flags,
// optional food priority, and input release on every exit path.
export async function runField(env, options, features, work) {
  const { manageFood = false, ...rest } = options;
  const field = new Fieldwork(env, rest);
  const survival = manageFood ? new Survival(field) : null;
  field.recoveringFood = manageFood;
  try {
    await field.start([...features, ...(manageFood ? foodFeatures : [])]);
    return await work(field, survival, rest);
  } finally {
    await env.send({ action: 'stop' });
  }
}

// Human-readable item name for server chat announcements.
export const cleanName = code => String(code ?? '').split(':').pop().replace(/[-_]/g, ' ').trim() || 'something';
