import { z } from 'zod';
import { defineGoal } from '../runtime/define.ts';
import { blockTarget } from '../runtime/schemas.ts';
import { runField } from '../support/task.ts';
import { closeContainer, openContainer } from './store_items.ts';

export default defineGoal({
  name: 'inspect_container',
  schema: z.object({ target: blockTarget, timeoutMs: z.number().int().min(1000).max(60000).default(20000) }).strict(),
  destructive: true,
  description: 'Open an observed container within reach, read its visible slots, then close it. Returns START; poll goal_status.',
  title: () => 'Check stored supplies',
  announce: () => 'Checking the supplies.',
  run: (env, options) =>
    runField(env, options, ['containers'], async field => {
      try {
        const container = await openContainer(field, options);
        return { ok: true, goal: 'inspect_container', contents: container.slots, verification: 'client_observed' };
      } finally {
        await closeContainer(field);
      }
    }),
});
