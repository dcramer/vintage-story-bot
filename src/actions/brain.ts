import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { installBrain } from '../runtime/brain.ts';

// Which brain runs the bot. Read: the installed brain and its last decision.
// Set: install a brain by name (a file in src/brain) or none. A brain waits
// while a goal someone else started runs, so installing one is always safe.
export default defineAction({
  name: 'brain',
  schema: z.object({
    name: z.string().regex(/^[a-z][a-z0-9_-]{0,31}$/).nullable().optional()
      .describe('Brain to install, e.g. default; null removes the brain. Omit to read status.'),
  }).strict(),
  readOnly: true,
  idempotent: true,
  description:
    'Read or set the installed brain. With a brain the bot keeps itself alive on its own: respawns, flees, eats, hides at ' +
    'night, works its day-1 kit, and starts goals only when nothing else runs; goals started here take precedence. ' +
    'Without one it does nothing until told. name omitted: status only; null: remove.',
  local: async (runtime, { name }) => {
    if (name !== undefined) await installBrain(runtime, name);
    return { ok: true, brain: runtime.brain?.status() ?? null };
  },
});
