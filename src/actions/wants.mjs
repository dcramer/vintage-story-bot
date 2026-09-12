import { z } from 'zod';
import { defineAction } from '../runtime/define.mjs';

// The shopping list: code substrings every goal picks up when they lie within a few
// blocks of its path (loose sticks, stones, flints, dropped items). A brain refreshes
// it every tick; without a brain an adapter sets it here.
export default defineAction({
  name: 'wants',
  schema: z.object({
    list: z.array(z.string().min(1).max(64)).max(16).optional().describe('Replace the list; omit to read it.'),
  }).strict(),
  readOnly: true,
  idempotent: true,
  description:
    'Read or set what the bot picks up in passing during any goal: block/item code substrings such as stick, flint, ' +
    'loosestones. Pickups pause the walk for a moment; nothing is searched for. A brain overwrites the list each tick.',
  local: async (runtime, { list }) => {
    if (list) runtime.wants = list;
    return { ok: true, wants: runtime.wants };
  },
});
