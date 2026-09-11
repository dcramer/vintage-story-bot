import { Fieldwork } from './fieldwork.mjs';
import { Survival } from './survival.mjs';

export const foodCapabilities = ['forage_state', 'food_freshness', 'block_actions'];

// Standard goal session: guarded Fieldwork start with required mod capabilities,
// optional food priority, and input release on every exit path.
export async function runField(env, options, capabilities, work) {
  const { manageFood = false, ...rest } = options;
  const field = new Fieldwork(env, rest);
  const survival = manageFood ? new Survival(field) : null;
  field.recoveringFood = manageFood;
  try {
    await field.start([...capabilities, ...(manageFood ? foodCapabilities : [])]);
    return await work(field, survival, rest);
  } finally {
    await env.send({ action: 'stop' });
  }
}

// Human-readable item name for server chat announcements.
export const cleanName = code => String(code ?? '').split(':').pop().replace(/[-_]/g, ' ').trim() || 'something';
