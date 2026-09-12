import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';
import { salient } from '../runtime/game.ts';

// The watch list: block code substrings the eye is looking out for. What a
// player notices anyway (salient) is always on it; the list here is added.
export default defineAction({
  name: 'watch',
  schema: z
    .object({
      list: z.array(z.string().min(1).max(64)).max(16).optional().describe('Replace the added codes; omit to read.'),
    })
    .strict(),
  readOnly: true,
  idempotent: true,
  description:
    'Read or set the watch list: block code substrings the eye reports as sightings while the head turns. ' +
    'Always includes what a player notices anyway (ore, berry, stick, flint, loose, mushroom, cattail, chest, basket, vessel, fire, torch); ' +
    'at most 16 in all. A running goal sets its own attention and replaces this list while it looks.',
  local: async (runtime, { list }) => {
    if (list) runtime.game.attend(list);
    return { ok: true, watch: runtime.game.watch, salient };
  },
});
