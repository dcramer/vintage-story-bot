import { z } from 'zod';
import { defineAction } from '../runtime/define.ts';

export const kinds = { all: null, blocks: 'block', items: 'item', entities: 'entity' };

export const schema = z
  .object({
    match: z.string().min(1).max(64).optional().describe('Code substring to keep.'),
    matches: z.array(z.string().min(1).max(64)).min(1).max(4).optional().describe('Alternative code substrings to keep.'),
    kind: z.enum(['all', 'blocks', 'items', 'entities']).default('all'),
    radius: z.number().int().min(1).max(128).default(64).describe('Blocks from the eye.'),
    limit: z.number().int().min(1).max(128).default(32),
    remembered: z.boolean().default(true).describe('false: only what is in view right now.'),
  })
  .strict()
  .refine(value => !(value.match && value.matches), { message: 'Use match or matches, not both' });

// The noun for what the eye has confirmed: entities, dropped items and watched
// blocks, in view now or remembered at their last known point. Controller
// memory only; nothing is queried from the world.
export default defineAction({
  name: 'sightings',
  schema,
  readOnly: true,
  description:
    'What the eye has confirmed, nearest first: entities, dropped items and watched blocks a line of sight reached, ' +
    'each visible (in view now) or remembered (last seen ageMs ago; entities 20 s, items 60 s, blocks a week). ' +
    'Memory only, never a world query: absent means unknown. Blocks appear only while their code is on the watch list; ' +
    'the eye keeps looking while the head turns, so look_around first to see what is behind you. Revalidate keys before acting.',
  local: async (runtime, { match, matches, kind, radius, limit, remembered }) => {
    const state = await runtime.snapshot();
    const eye = { ...state.position, y: state.position.y + (state.body?.eyeHeight ?? 1.6) };
    const objects = runtime.sightings.view(eye, {
      matches: matches ?? (match ? [match] : []),
      kind: kinds[kind],
      radius,
      remembered,
      reach: state.pickingRange ?? 4.5,
    });
    return {
      ok: true,
      watch: runtime.game.watch,
      visible: objects.filter(o => o.visible).length,
      remembered: objects.length - objects.filter(o => o.visible).length,
      more: objects.length > limit,
      objects: objects.slice(0, limit),
    };
  },
});
