import { Fieldwork } from '../skills/fieldwork.mjs';
import { changeBlock } from '../skills/blocks.mjs';

export async function blockGoal(env, kind, options) {
  const field = new Fieldwork(env, options);
  try {
    await field.start(['block_actions']);
    return await changeBlock(field, kind, options);
  } finally {
    await env.send({ action: 'stop' });
  }
}
